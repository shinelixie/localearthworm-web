# Earthworm · 纯前端版(GitHub Pages)

[https://shinelixie.github.io/localearthworm-web/](https://shinelixie.github.io/localearthworm-web/)

这是 [Earthworm 本地版](https://github.com/shinelixie/localearthworm) 的**纯前端站点仓库**:
没有 API、没有数据库 —— 课程内容打包在 `apps/client/public/data/courses.json`,
学习进度/收藏/练习记录存用户浏览器 IndexedDB。

GitHub 不允许在 fork 仓库启用 Pages,所以站点发布在这个非 fork 仓库上;
功能开发在主仓库 `shinelixie/localearthworm`(含 API/数据库/批量工具,全量保留),
完成后再同步 commit 到这里 —— 本仓库只收纯前端相关改动,
push 到 `main` 后 `.github/workflows/pages.yaml` 自动构建部署。

## 目录

- `apps/client/` — Nuxt 3 前端(`ssr: false`;web 模式走 `composables/web/` 浏览器端后端)
- `apps/client/public/data/courses.json` — 课程内容(由主仓库 `pnpm web-data` 从 Postgres 导出)
- `tools/build-web-data.mjs` — 导出脚本(内容更新时在主仓库重跑后同步过来)
- `apps/client/public/tts/` + `data/tts-manifest.json` — 预合成的神经语音音频与 `文本→地址` 查表(见下「发音」)
- `使用说明.md` / `课程包导入说明.md` — 站内 `/help` 文档源
- `.github/workflows/pages.yaml` — Pages 构建部署
- `apps/client/utils/helpDocs.generated.ts` — 由 `pnpm docs:help` 生成的帮助页内容(随仓库发布)

## 重新发布

1. 主仓库里改了课程数据 → `pnpm web-data` 重新导出 `courses.json`
2. 本仓库 `git commit` 后 `git push origin main`,GitHub Actions 自动部署

本地验证:`pnpm install && pnpm build`(产物在 `apps/client/.output/public`,
用 `python3 -m http.server` 挂到 `/localearthworm-web/` 子路径下预览)。

## 相对本地版缺少的能力

服务端 TTS 合成(改走有道 dictvoice + 浏览器系统语音)、FSRS 复习排期(入口保留、队列为空)、
在线翻译、排行榜、跨设备同步。详见主仓库 README。

许可沿用上游 **AGPL-3.0**(见 [LICENSE](./LICENSE))。
