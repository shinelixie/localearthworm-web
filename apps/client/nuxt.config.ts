// https://nuxt.com/docs/api/configuration/nuxt-config

const appScripts: any = [];
if (process.env.NODE_ENV === "production") {
  addClarity();
}

// for https://clarity.microsoft.com/
function addClarity() {
  appScripts.push({
    innerHTML: `(function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "${process.env.CLARITY}");`,
  });
}

// 纯前端（GitHub Pages）构建：NUXT_PUBLIC_WEB=true（build:web 通过 --dotenv .env.web 注入）。
// 该开关让 api/http.ts 改走浏览器端后端（composables/web/）：
// 内容读 public/data/courses.json，学习数据写 IndexedDB，发音走有道 + 浏览器兜底。
const isWeb = process.env.NUXT_PUBLIC_WEB === "true" || !process.env.API_BASE;
// GitHub Pages 子路径：https://<user>.github.io/<repo>/
// 纯前端版发布在非 fork 的独立仓库 shinelixie/localearthworm-web，
// 所以 base 固定为 /localearthworm-web/；换仓库时用 NUXT_PUBLIC_BASE_URL 覆盖
const webBase = process.env.NUXT_PUBLIC_BASE_URL || "/localearthworm-web/";

export default defineNuxtConfig({
  ssr: false,
  // default is true, reference to https://nuxt.com/docs/guide/directory-structure/components
  // components: true,
  imports: {
    autoImport: false,
  },
  devtools: {
    enabled: true,
  },
  app: {
    // 纯前端版部署在仓库子路径下，资源与数据文件都挂在这个 base 下
    baseURL: isWeb ? webBase : "/",
    head: {
      title: "Earthworm",
      link: [{ rel: "icon", href: `${isWeb ? webBase.replace(/\/?$/, "") : ""}/favicon.ico` }],
      script: appScripts,
    },
  },
  // 纯前端版只做静态 SPA 壳，不抓取客户端路由（那是前端 hash 路由处理的）。
  // output 指向独立目录 dist-web：本地版(pnpm build)写 .output、网页版(build:web)写
  // dist-web，两套产物互不覆盖 —— 同写 .output 时谁后构建谁就把另一方的 bundle 冲掉
  //（表现为先启动的那个服务白屏：旧 HTML 引用已不存在的 hash 资产）。
  nitro: isWeb
    ? {
        output: {
          dir: "dist-web",
          publicDir: "dist-web/public",
        },
        prerender: {
          crawlLinks: false,
          routes: ["/"],
        },
      }
    : {},
  // 纯前端版部署在 GitHub Pages：静态服务器对深链刷新不做 SPA 回退会 404，
  // hashMode 让路由走 #/xxx，URL 永远不发往服务器，刷新/分享都不会 404
  router: isWeb ? { options: { hashMode: true } } : {},
  css: ["~/assets/css/globals.css"],
  modules: [
    "@nuxt/ui",
    "@vueuse/nuxt",
    "@nuxt/test-utils/module",
    "@hypernym/nuxt-anime",
    "@nuxt/image",
  ],
  plugins: ["~/plugins/logto.ts", "~/plugins/http.ts"],
  runtimeConfig: {
    public: {
      apiBase: process.env.API_BASE || "",
      // 浏览器端后端开关（见上）。API_BASE 为空也视为 web 模式，兜底安全。
      web: isWeb,
      endpoint: process.env.LOGTO_ENDPOINT || "",
      appId: process.env.LOGTO_APP_ID || "",
      backendEndpoint: process.env.BACKEND_ENDPOINT || "",
      signInRedirectURI: process.env.LOGTO_SIGN_IN_REDIRECT_URI || "",
      signOutRedirectURI: process.env.LOGTO_SIGN_OUT_REDIRECT_URI || "",
      helpDocsURL: process.env.HELP_DOCS_URL || "",
    },
  },
  build: {
    transpile: ["vue-sonner"],
  },
});
