"""批量 edge-tts 合成（build-web-tts.mjs 的兜底通道）
====================================================================
API 的 TTS worker 有固定的 ~25s 任务超时，而 Bing/edge-tts 偶发慢到 30s+，
批量补齐上万条语块时走 API 会批量 500。这里用独立的常驻 Python 进程直接
调 edge-tts：超时/并发/重试都自己控，已存在的输出文件跳过（可断点续跑）。

输入：stdin 逐行 NDJSON：{"text": "...", "out": "/abs/path/xx.mp3"}
输出：逐行 JSON（进度 / 失败明细 / 最终汇总），退出码 0=全部成功，1=有失败。

环境变量：
  TTS_PROXY   代理（本机必须走代理才能连上 Microsoft 端点），默认 http://127.0.0.1:7890
  TTS_VOICE / TTS_RATE   默认 en-US-JennyNeural / +0%（须与清单哈希一致）
  TTS_BATCH_CONCURRENCY  并发，默认 3
  TTS_BATCH_TIMEOUT      单条超时秒，默认 90
  TTS_BATCH_RETRIES      每条重试次数，默认 4
"""
import asyncio
import json
import os
import sys

try:
    import edge_tts
except Exception as exc:  # pragma: no cover
    sys.stderr.write(f"edge-tts 不可用: {exc}\n")
    raise SystemExit(1)

VOICE = os.environ.get("TTS_VOICE", "en-US-JennyNeural")
RATE = os.environ.get("TTS_RATE", "+0%")
PROXY = os.environ.get("TTS_PROXY") or "http://127.0.0.1:7890"
CONCURRENCY = max(1, int(os.environ.get("TTS_BATCH_CONCURRENCY", "3")))
TIMEOUT = float(os.environ.get("TTS_BATCH_TIMEOUT", "90"))
RETRIES = max(0, int(os.environ.get("TTS_BATCH_RETRIES", "4")))
RETRY_BASE = 2.0


async def synth(text: str, out: str) -> int:
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, proxy=PROXY)
    buf = bytearray()

    async def drain():
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])

    await asyncio.wait_for(drain(), timeout=TIMEOUT)
    if not buf:
        raise RuntimeError("合成结果为空")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    tmp = out + ".part"
    with open(tmp, "wb") as fp:
        fp.write(bytes(buf))
    os.replace(tmp, out)
    return len(buf)


async def main() -> int:
    sem = asyncio.Semaphore(CONCURRENCY)
    lock = asyncio.Lock()
    state = {"done": 0, "failed": []}

    def record(ok: bool, text: str, err=None):
        state["done"] += 1
        if not ok:
            state["failed"].append((text, str(err)))
        if state["done"] % 25 == 0:
            print(f"synth progress {state['done']}", flush=True)

    async def worker(line: str):
        job = json.loads(line)
        text = (job.get("text") or "").strip()
        out = job["out"]
        if not text or not out or os.path.exists(out):
            return

        delay = RETRY_BASE
        last = None
        for attempt in range(RETRIES + 1):
            async with sem:
                try:
                    await synth(text, out)
                    record(True, text)
                    return
                except Exception as exc:  # noqa: BLE001 —— 重试靠的就是吞异常
                    last = exc
            if attempt < RETRIES:
                await asyncio.sleep(delay)  # 退避放在信号量外，不占并发位
                delay = min(delay * 2, 30)
        record(False, text, last)

    lines = [l for l in sys.stdin.read().splitlines() if l.strip()]
    total = len(lines)
    print(f"synth start total={total} concurrency={CONCURRENCY} proxy={PROXY}", flush=True)
    await asyncio.gather(*(asyncio.create_task(worker(l)) for l in lines))
    for text, err in state["failed"]:
        print(json.dumps({"failed": text, "error": err}, ensure_ascii=False), flush=True)
    print(
        json.dumps({"done": state["done"], "failed": len(state["failed"])}),
        flush=True,
    )
    return 1 if state["failed"] else 0


sys.exit(asyncio.run(main()))
