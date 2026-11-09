# dsh--web-fetch

> 一个给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) 用的**可编排网页抓取 provider**：把直连、Jina Reader、firecrawl、fastCRW、Exa、无头浏览器、CDP、Lightpanda 串成一条**你可以拖动排序**的回退链，并支持**按站点锁定专用抓取**（知乎开放平台、小红书 Cookie）。
>
> An **orchestratable web-fetch provider** for DeepSeek Harness: direct HTTP, Jina Reader, firecrawl, fastCRW, Exa, headless browser and Lightpanda, chained into a fallback order **you can drag to reorder**.

---

## 为什么需要它 / Why

DSH 自带的抓取链在「直连失败」之后会**立刻启动系统浏览器的无头渲染**，而这一步在部分机器上会空转满 25 秒超时才轮到云端 API —— 结果是每个硬站都要先白等半分钟。

The stock chain tries a headless system browser **immediately** after a failed direct request. On some machines that step stalls for the full 25-second timeout before the cloud tiers get a turn — so every hard site costs half a minute.

这个插件把「顺序」交给你：

- 想要最快的：`direct → jina → firecrawl`
- 想要最稳的：`firecrawl → crw → jina → direct`
- 没有 API key 也能用：`direct → jina → browser`
- 想要啃 Cloudflare：把 `crw` 提到前面

拖动即生效，不需要重启。

This plugin hands the ordering back to you. Drag to reorder; it takes effect immediately, no restart.

---

## 功能 / Features

| 能力 | 说明 |
| --- | --- |
| **10 个抓取后端** | 直连 HTTP、Jina Reader（免 key）、firecrawl、fastCRW、Exa、无头浏览器（Obscura）、CDP（Chromium 持久登录态）、Lightpanda、知乎开放平台、小红书（Cookie） |
| **站点规则** | 按域名后缀锁定后端：命中规则就**只走那一档、失败直接报错**，不再回退通用链。默认已配好知乎（问题/回答走开放平台 API、专栏走 Jina）与小红书 |
| **API Key 内联编辑** | 卡片里直接填 firecrawl / Exa / Jina / 知乎的 Key 与小红书 Cookie，保存到 `~/.dsh/dsh-web-fetch/keys.json`（0600）；留空自动复用 DSH 凭据里同名 Key（知乎的 `ZHIHU_API_KEY` 就是 websearch 里那份） |
| **浏览器可换** | 默认 Obscura（Rust 自渲染，无需 Chromium），也可填本机 Chromium/Chrome 路径走 `--dump-dom`；一键下载 Obscura |
| **拖动排序** | 插件卡片里 HTML5 拖拽调整回退顺序，实时写盘；每行另有 `↑` / `↓` 按钮，不方便拖拽时也能排序 |
| **逐项开关** | 每个后端单独启用/禁用；缺 key 或缺二进制的会自动跳过 |
| **连通性测试** | 输入 URL 一次跑完整条链，逐档显示耗时与字节数，失败附原因 |
| **质量闸门** | 结果短于阈值时不算成功，会继续尝试下一档；全部偏短则返回最长的一份 |
| **性能优化层** | URL 缓存（TTL 可调）、域名亲和（记住哪个档在这个站能用、把已失败的档降级）、全局 deadline、可选前两档并发竞速、连接复用；卡片里可开关与清空 |
| **CRW 自动部署** | 打开 `crw` 开关即自动下载 `crw-server`（23MB 单文件）、生成配置、绑 `127.0.0.1` 启动，**无鉴权、仅回环** |
| **运行时接管** | 插件自动把 `web.fetchProvider` 指向自己（仅当当前是空或 `http` 时，不抢占显式选择） |
| **Web 卡片** | 设置页内可视化卡片；另有独立拖拽页 `/api/dsh-web-fetch/ui` |

---

## 安装 / Install

```bash
# 从 npm（发布后）
dsh plugin --profile desktop add dsh--web-fetch

# 从 GitHub 源码（纯 JS，无需构建）
dsh plugin --profile desktop add github:liamugong/dsh--web-fetch

# 本地开发
git clone <this repo> && cd dsh--web-fetch
dsh plugin --profile desktop add ./
```

安装后重启 DSH，或在「设置 → 插件」里找到 **dsh--web-fetch**。

> 插件默认**不**静态改写 `web.fetchProvider`：bundle patch 只 `insert` 自己的 row。运行时若发现 `web.fetchProvider` 为空或仍是 `http`，才会接管。若你已显式指定了别的 provider，请在 profile 的 `cordis.patch.yml` 里手动改：
>
> ```yaml
> - id: web
>   config:
>     searchProvider: ddg
>     fetchProvider: dsh-web-fetch
> ```

---

## 后端 / Backends

| id | 名称 | 需要 | 适合 | 备注 |
| --- | --- | --- | --- | --- |
| `direct` | 直连 HTTP | 无 | 静态页、API、RSS | 进程内 `node:http(s)`，跟随重定向，浏览器 UA，零额外开销 |
| `jina` | Jina Reader | 无 | 通用正文清洗 | `https://r.jina.ai/<url>`，免 key 有速率限制；输出已剥 `Title:` / `URL Source:` |
| `firecrawl` | firecrawl v2 | `FIRECRAWL_API_KEY` | 反爬站、Cloudflare | `POST /v2/scrape` → markdown，最稳的一档 |
| `crw` | fastCRW 本地 | 无（自动下载） | 想要自托管、不想用云 API | 见下节 |
| `exa` | Exa Contents | `EXA_API_KEY` | 语义检索配套抓取 | `POST /contents` |
| `browser` | 无头浏览器 | 本机 Obscura（默认）或 Chrome/Chromium | 需要 JS 渲染的页 | Obscura 走 `fetch --dump markdown --quiet`；Chromium 走 `--dump-dom`，**故意不加 `--user-data-dir`**（见下） |
| `cdp` | CDP 浏览器 | 本机 Chromium/Chrome | 需要登录态 / 复杂 JS | 启动一个 headless Chromium 并走 CDP 取 `outerHTML`；profile 可持久化，登录一次后续复用 |
| `lightpanda` | Lightpanda | 本机 `lightpanda` 二进制 | markdown 预处理 | 快但中文站基本全挡，不建议当主力 |
| `zhihu` | 知乎开放平台 | `ZHIHU_API_KEY` | 知乎问题/回答页 | 调 `question_answers` 接口，返回**回答摘要**（非全文）；额度默认 100 次/天 |
| `xiaohongshu` | 小红书（Cookie） | 小红书 Cookie | 小红书笔记详情页 | 复用登录态请求页面并解析 `window.__INITIAL_STATE__`；无 Cookie 直接报错 |

### 小红书 / Xiaohongshu notes

小红书没有公开读接口，能跑通的只有两条路：**① 登录 Cookie 回放**（本插件默认）、**② 登录态浏览器（cdp 档）**。

- 插件读取笔记页 HTML 里的 `window.__INITIAL_STATE__`，从 `note.noteDetailMap` 取标题/作者/互动数/正文/话题/图片/视频和热评。
- **必须带 `xsec_token`**：新版笔记 URL 形如 `/explore/<id>?xsec_token=...`，少了这个参数服务端只回空壳页面。插件会保留原始查询串。
- 页面里的状态对象不是合法 JSON（含 `undefined`、`new Map([])`），插件做了字面量清洗后再解析。
- Cookie 至少要有 `a1` 与 `web_session`；登录后还会带 `id_token`。放进「接口密钥 → 小红书 Cookie」，或用 cdp 档指向已登录的 profile。

### 站点规则 / Site rules

有些站点不该「碰运气」：通用回退链会把时间浪费在注定失败的档位上，还可能把登录墙当成正文。站点规则就是为此设计的——命中域名后**只走指定后端**，成功即返回，失败**直接报错**，绝不回退。

规则按域名后缀匹配，子域自动命中，越具体的域名优先。默认规则：

| 域名 | 后端 | 说明 |
| --- | --- | --- |
| `zhuanlan.zhihu.com` | `jina` | 知乎专栏：开放平台没有全文接口（`/api/v1/content/detail` 返回 `permission denied`），固定走 Jina Reader |
| `zhihu.com` | `zhihu` | 知乎问题/回答：走开放平台 `question_answers`，返回每条回答的摘要 |
| `xiaohongshu.com` | `xiaohongshu` | 小红书笔记：需要登录 Cookie，没有就报错 |

**知乎**用的是开放平台 REST 接口，不是网页抓取：

```
GET https://developer.zhihu.com/api/v1/content/question_answers
    ?QuestionUrl=https://www.zhihu.com/question/<id>&Offset=0&Limit=50
Authorization: Bearer <Access Secret>
X-Request-Timestamp: <秒级时间戳>
```

- 支持问题页 `/question/<id>` 与回答页 `/question/<id>/answer/<aid>`（后者会按 `ContentToken` 精确匹配那一条并置顶）。
- 文档明确说明 `Summary` 是**摘要或截取文本，不代表回答全文**——插件会在输出顶部标注这一点，不会假装是全文。
- 该接口与「问题推荐」共用「问题发现」额度，默认每租户每天 100 次（低额度账号 10 次）。额度耗尽会返回 `30001`。

**小红书**没有公开读接口，两条可行路径：① 登录态 Cookie + 解析页面内嵌 `__INITIAL_STATE__`（本插件实现，也是 XHS-Downloader / xhs SDK 的思路）；② 用 `cdp` 后端挂一个登录过的浏览器。Cookie 至少需要 `a1` 与 `web_session`。

> 站点规则只对**命中域名**生效；未命中的站点继续走上面的通用回退链。

### 质量闸门 / Quality gate

一档返回的正文短于 `minChars.accept`（默认 400 字符）时不算成功，继续试下一档；如果全部偏短，则在短于 `minChars.floor`（默认 80）时硬失败，否则返回最长的一份 —— 这样既不会把「Just a moment…」当正文，也不会让一个真的只有一句话的页面直接报错。

### 关于无头浏览器 / About the browser tier

**默认引擎是 [Obscura](https://github.com/h4ckf0r0day/obscura)**（Rust 写的无头浏览器，自带渲染引擎，不需要 Chromium）。插件会调用：

```bash
obscura fetch <url> --dump markdown --timeout <s> --allow-private-network --quiet [--stealth]
```

`--allow-private-network` + `OBSCURA_ALLOW_PRIVATE_NETWORK=1` 是必须的：Obsura 默认拦截私网地址，而 TUN/fake-IP 代理（Clash/Surge/Loon）会把公网域名解析到 `198.18.0.0/15`，不加这个开关会全部被 SSRF 拦截。

也可以在卡片里把路径改成任意 Chromium/Chrome 可执行文件，此时回退到 `--headless=new --dump-dom`。注意 `--dump-dom` 与 `--user-data-dir` 同时出现时，Chromium 会在输出完 DOM 后**不退出**（[Chromium issue 547894779](https://issues.chromium.org/issues/547894779)），所以这条路径**不传** `--user-data-dir`。需要登录态请改用 CRW + 常驻 CDP。

### 浏览器兜底怎么选 / Which browser fallback

**先别上浏览器。** `direct → jina → firecrawl → crw` 已经覆盖绝大多数站点；浏览器只在「必须执行 JS、且站点不挡」时才有价值。确实要本地兜底时，按这个顺序考虑：

| 选择 | 适合 | 实测 | 代价 |
| --- | --- | --- | --- |
| `cdp`（本插件内置） | 登录后才有内容的站点、复杂 JS | example.com 1.2s（首次含冷启 1.7s） | 常驻 Chromium 约 300–400MB |
| `browser` + Obscura | 无反爬的 JS 页 | 单进程 26–80MB，nowsecure.nl 7.6s | Cloudflare 一律拿挑战页 |
| Patchright + 系统 Chrome | 想尽量过 CF | 公开基准 25/31 | 需 headful + 住宅 IP；本机机房 IP 实测仍过不了 npmjs |

不建议：`nodriver`（公开基准第一 28/31，但本机实测 npmjs 只拿到「请稍候…」安全验证页，且 AGPL）、`Camoufox`（下载 1.29GB、最慢）、`lightpanda`（中文站全挡）。

> 硬结论：在本机出口 IP（东京 AS205548 机房段）上，**任何本地浏览器都过不了 Cloudflare 的 JS 挑战**。要稳定过强 CF 只有云端 unblocker（firecrawl）或换住宅 IP 两条路。

**怎么设：**

- **CDP**：在顺序列表里打开 `cdp` 并拖到合适位置；端口默认 `9333`，`userDataDir` 留空则用 `~/.dsh/dsh-web-fetch/chrome-profile`。要登录态就先用这个 profile 手动登录一次。
- **Obscura / Chromium**：卡片「浏览器引擎」里路径留空 = 自动检测（优先 Obscura）；填 `/Applications/Chromium.app/Contents/MacOS/Chromium` 则走 `--dump-dom`。

---

## 自编译 CRW（stealth 构建）/ Building CRW with stealth tiers

官方预编译的 `crw-server` **没有**编译 `cdp` / `camoufox` / `cloak` / `impersonated` 特性，`/v1/capabilities` 的 `renderers.available` 是空数组，请求 `impersonated-http` 会直接报 `not available`。

自编译（tag `v0.43.1`）：

```bash
cargo build --release -p crw-server --features cdp,camoufox,cloak,impersonated
```

macOS 上 `btls-sys`（BoringSSL）常会失败，报 `bcm.cc: fatal error: 'memory' file not found` —— 原因是 Command Line Tools 的 libc++ 头文件缺失。换 Homebrew LLVM 的 clang 即可：

```bash
CC=/opt/homebrew/opt/llvm/bin/clang CXX=/opt/homebrew/opt/llvm/bin/clang++ \
CMAKE_C_COMPILER=/opt/homebrew/opt/llvm/bin/clang CMAKE_CXX_COMPILER=/opt/homebrew/opt/llvm/bin/clang++ \
cargo build --release -p crw-server --features cdp,camoufox,cloak,impersonated
```

编出来的二进制约 26MB，`renderers.available` 会变成 `["impersonated-http"]`。实测边界：

- `impersonated-http` 只解决 **TLS 指纹**，解决不了 Cloudflare 的 JS 挑战（npmjs / Stack Overflow 仍报 anti-bot block）。
- `cloak` / `camoufox` 是**外部 REST sidecar**（CloakBrowser 服务 + 住宅代理 / Camoufox 服务），本机没有，所以属于「能力已编进去、但暂时没有后端可用」。

把编好的二进制放到 `~/.dsh/dsh-web-fetch/bin/crw-server-stealth`，并在 `state.json` 里把 `crw.binaryPath` 指过去即可（插件不会覆盖已存在的 `binaryPath`）。

---

## CRW：本地无鉴权部署 / Local unauthenticated CRW

[fastCRW](https://github.com/fastcrw/crw) 是一个 Rust 写的单文件爬虫服务（firecrawl 兼容 API，AGPL-3.0）。

打开 `crw` 开关后，插件会：

1. 从 GitHub Release 下载对应平台的 `crw-server-<os>-<arch>.tar.gz`（macOS arm64 约 10MB，解开 23MB）
2. 解压到 `~/.dsh/dsh-web-fetch/bin/crw-server`
3. 生成 `~/.dsh/dsh-web-fetch/run/config.toml`
4. 以 `CRW_ALLOW_LOOPBACK_FOR_TESTS=1` 启动，**绑定 `127.0.0.1:38210`，不设 API key**

> ⚠️ 无鉴权 = 本机任何能访问回环端口的进程都能用它。绑定 `127.0.0.1` 保证局域网访问不到。若你想加鉴权，改配置里的 `[auth] api_keys` 并同步改插件设置（暂未暴露 UI）。
>
> ⚠️ 你的 DNS 如果是 Clash/Surge/Loon 的 TUN fake-IP（解析结果落在 `198.18.0.0/15`），CRW 的 SSRF 防护会把公网地址当成私网而拒绝 —— 这就是启动时必须带 `CRW_ALLOW_LOOPBACK_FOR_TESTS=1` 的原因。

### 渲染模式 / Renderer mode

`crw.rendererMode` 取值：

- `auto`（默认）：没有配置 `chromeWsUrl` 时自动降级为 `none`（纯 HTTP）；配置了就升级为 `chrome`
- `none`：纯 HTTP，服务本身约 14MB RSS，**90% 的站点够用**
- `chrome`：需要外部 CDP，例如
  ```bash
  "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
    --headless=new --remote-debugging-port=9223 --user-data-dir=/tmp/cft-profile \
    --no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled
  ```
  然后在插件配置里设 `crw.chromeWsUrl: ws://127.0.0.1:9223`。代价：Chrome 侧常驻约 300–400MB。

> CRW 自己**不会**拉起浏览器，只认外部 CDP 地址。

---

## 配置 / Configuration

全部配置都在 profile 的 `cordis.patch.yml` 里，也可以由插件卡片写入 `~/.dsh/dsh-web-fetch/state.json`（卡片优先）。

```yaml
- id: web-fetch
  name: dsh--web-fetch
  config:
    order: [direct, jina, firecrawl, crw, exa, browser, lightpanda]
    enabled:
      direct: true
      jina: true
      firecrawl: true
      crw: true
      exa: true
      browser: false
      lightpanda: false
    crw:
      autoStart: true          # 启用 crw 时自动下载并启动
      host: 127.0.0.1          # 只绑回环
      port: 38210
      version: v0.43.1         # 固定版本，避免上游破坏性变更
      autoDownload: true
      rendererMode: auto       # auto | none | chrome
      chromeWsUrl: ""          # 有值才会启用 chrome 渲染
    timeouts:                  # 每档超时（毫秒）
      jina: 20000
      firecrawl: 30000
      crw: 60000
      exa: 25000
      browser: 20000
      lightpanda: 20000
    minChars:
      accept: 400              # 低于此值视为「不够用」，继续下一档
      floor: 80                # 全部失败时，低于此值才硬报错
    deadlineMs: 45000          # 一次 fetch 的总预算，跨所有档；到点即停
    cache:                     # 同一 URL 的整份结果缓存
      enabled: true
      ttlMs: 600000            # 10 分钟
      maxEntries: 200          # LRU 上限
    affinity:                  # 域名 → 档位记忆
      enabled: true
      ttlMs: 1800000           # 30 分钟
    hedge:                     # 前 N 档并发竞速（默认关：用请求数换延迟）
      enabled: false
      count: 2
    browserPath: ""            # 留空自动探测 Chromium / Chrome / Thorium / Edge
    lightpandaPath: ""         # 留空从 PATH 找 lightpanda
```

### API Key 解析顺序 / Key resolution

1. 插件内保存的 Key（`~/.dsh/dsh-web-fetch/keys.json`，权限 0600）——卡片里「接口密钥」面板直接编辑
2. DSH `credentials` 服务（若可用）
3. `~/.dsh/.credentials.yaml` 里的 `FIRECRAWL_API_KEY` / `EXA_API_KEY` / `JINA_API_KEY` / `TAVILY_API_KEY` / **`ZHIHU_API_KEY`**（以及 `XIAOHONGSHU_COOKIE`，可选）
4. 进程环境变量同名变量

> 也就是说：**在 DSH / websearch 里填过的 firecrawl Key 与知乎 Access Secret 都会被自动复用**，卡片会显示「来自 DSH 凭据」；只有在卡片里另填一份时才会覆盖。小红书 Cookie 没有官方凭据项，需要在卡片里单独填。

---

## HTTP 接口 / Bridge API

插件在 DSH 的 web server 上注册了这些路由（供卡片使用，也可以直接用）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-web-fetch/state` | 当前状态：顺序、开关、后端可用性、CRW 状态、Key 状态、浏览器状态 |
| GET/POST | `/api/dsh-web-fetch/keys` | `{ id, value }` → 保存/清除插件内 Key；`value` 为空表示清除 |
| POST | `/api/dsh-web-fetch/config` | `{ browserPath, browserEngine, browserStealth, timeouts }` |
| POST | `/api/dsh-web-fetch/browser` | `{ action: "detect" \| "download" \| "test", url? }` |
| POST | `/api/dsh-web-fetch/order` | `{ order: ["direct", ...] }` |
| GET/POST | `/api/dsh-web-fetch/rules` | GET 返回规则与可选后端；POST `{ rules: [...] }` 覆盖，或 `{ action: "reset" }` 恢复默认 |
| POST | `/api/dsh-web-fetch/toggle` | `{ id, enabled }` |
| POST | `/api/dsh-web-fetch/crw` | `{ action: "start" \| "stop" \| "restart" }` |
| POST | `/api/dsh-web-fetch/test` | `{ url, id? }` → 逐档耗时/字节/错误 |
| GET | `/api/dsh-web-fetch/ui` | 自包含的拖拽排序页 |

---

## 开发 / Development

```bash
node --check index.js
node --check lib/backends.js
node --check lib/crw.js
node --check client.js

# 离线测试（假 ctx，不碰真实 profile）
node test/harness.mjs
```

目录：

```
index.js           插件入口：状态、provider、bridge 路由
client.js          Web 卡片（window.__ModuleLoader__ 格式，自包含 React）
lib/backends.js    7 个后端 + 质量闸门 + 挑战页识别
lib/crw.js         CRW 生命周期管理（下载/配置/启停/健康检查）
cordis.patch.yml   bundle patch（只 insert 自己那一行）
test/harness.mjs   离线测试
```

---

## 推荐配置 / Recommended setup

实测下来最省时间也最省钱的一组设置（插件 v0.4.0 默认值即此）：

| 项 | 值 | 理由 |
| --- | --- | --- |
| 顺序 | `direct → firecrawl → crw → jina → browser → cdp → lightpanda → exa` | 静态页第一档 86–250ms 命中；强 CF 站第二档 firecrawl 必过（npmjs 2.5s / SO 1.1s）；非 CF 站第三档 crw 本地免费；jina 兜底正文清洗 |
| `exa` | 关闭 | 与 firecrawl 能力重叠，且需要单独的 key |
| `lightpanda` | 关闭 | 中文站基本全挡，收益低 |
| `cdp` | 关闭 | 需要常驻 Chromium（约 300–400MB），只有登录态站点才值得开 |
| URL 缓存 | 开，TTL 10 分钟，300 条 | 二次抓取 0ms |
| 域名亲和 | 开，30 分钟 | 记住每个站点的冠军档位，硬站省 0.6–0.85s（-27%~-44%） |
| 前两档竞速（hedge） | 关 | 会重复请求；firecrawl 按次计费，不建议默认开 |
| 全局 deadline | 40s | 防止单站拖死整轮；单档另有 cap |

> 站点规则独立于这张表：命中规则时直接走指定后端，**不参与上面的回退链**，失败也不会降级到通用链 —— 这样知乎这类「必须走官方 API」的站点不会先白等 25 秒浏览器超时。

## 优化层 / Optimisation layer

抓取慢往往不是慢在「发请求」，而是慢在**为必然失败的档付全额超时**。这一层专门解决它：

| 机制 | 作用 | 默认 |
| --- | --- | --- |
| **URL 缓存** | 同一 URL 的整份 `FetchResult` 直接命中，0ms | 开，TTL 10 分钟，LRU 200 条 |
| **域名亲和** | 记住每个域名上「哪个档真的成功过」；下次把它提到第一位，并把已经失败过的档降到队尾 | 开，TTL 30 分钟 |
| **全局 deadline** | 一次 `fetch()` 的总预算，跨所有档共享；每档实际超时 = `min(该档配置, 剩余预算)` | 45s |
| **前 N 档并发竞速** | `direct` 与 `jina` 同时发，谁先给出合格结果用谁，其余立刻 abort | 关（省 200–500ms，但打两份请求） |
| **连接复用** | HTTP/HTTPS Agent keep-alive，同一 origin 二次请求省约 120ms | 恒定开启 |
| **结构信号质量闸门** | 命中 Cloudflare / 登录墙文案的结果一律判失败，不再被当成正文 | 恒定开启 |

实测收益（同一台机器，2026-11）：

- npmjs 首次访问 1,636ms → 命中亲和后直接走 firecrawl，约 **920ms**（-44%）。
- 同一 URL 二次抓取：**0ms**（缓存）。
- 硬站最坏耗时从「每档各自超时累加 ~45s+」收敛到**受 deadline 约束的 15s 内**。

卡片里的「性能与缓存」面板可以开关缓存/亲和/竞速、改 TTL 与 deadline、清空缓存或亲和记录；对应 `POST /api/dsh-web-fetch/config` 与 `POST /api/dsh-web-fetch/cache`。

---

## 性能实测 / Benchmarks

macOS 15.7.1 arm64（Apple Silicon）· obscura 0.2.6（stealth）· Chromium 140.0.7339.185 · crw 0.43.1 · firecrawl v2。
每个后端**单独**跑，不走回退链，因此是「这一档本身有多快」，不是「一次 web_fetch 有多快」。

### 逐档：耗时 / 正文长度

| 页面 | direct | jina | firecrawl | crw | browser (obscura) |
| --- | --- | --- | --- | --- | --- |
| example.com | 211ms / 577B | ✗ 419ms | 795ms / 959B | 361ms / 174B | 511ms / 960B |
| mygo.egoist.dev/docs/ui | 429ms / 123KB | 417ms / 21KB | 496ms / 21KB | 360ms / 11KB | 1.3s / 15KB |
| arxiv.org/abs/2308.00001 | 294ms / 39KB | ✗ 258ms | 1.3s / 7KB | 213ms / 5KB | 2.4s / 11KB |
| en.wikipedia.org (Rust) | 952ms / 1.0MB | 3.3s / 261KB | 1.9s / 265KB | 757ms / 86KB | 6.7s / 195KB |
| github.com/zed-industries/zed | 907ms / 342KB | 16.5s / 126KB | 1.0s / 23KB | 694ms / 18KB | 6.8s / 35KB |
| stackoverflow.com/questions/11227809 | ✗ 403 | ✗ 403 | **1.7s / 193KB** | ✗ CF | ✗ CF 挑战页 |
| www.npmjs.com/package/react | ✗ 403 | ✗ 403 | **749ms / 5.5KB** | ✗ CF | ✗ CF 挑战页 |
| juejin.cn/post/7705441553616388146 | 181ms / 117KB | 1.0s / 26KB | 1.2s / 22KB | 145ms / 8KB | 2.0s / 10KB |

**怎么读这张表**：`direct` 在能直连的站上几乎总是最快（子 200ms 级）；`crw` 在没有 Cloudflare 的站上稳定低于 `firecrawl`；`firecrawl` 是唯一能稳定啃下 Cloudflare 的一档；`browser` 只在需要真实 JS 渲染、而前三档都拿不到正文时才值得开——它是最慢的一档。

### Obscura vs Chromium：单进程峰值内存与耗时

`/usr/bin/time -l` 的 `maximum resident set size`，同一页面、同一台机器：

| 页面 | Obscura | Chromium `--dump-dom` |
| --- | --- | --- |
| example.com | **0.28s / 26MB** | 1.04s / 201MB |
| mygo.egoist.dev/docs/ui | **1.5s / 80MB** | 2.00s / 203MB |
| arxiv.org/abs/2308.00001 | 2.04s / 74MB | **1.97s / 204MB** |
| en.wikipedia.org (Rust) | 6.47s / 359MB | **2.80s / 232MB** |

结论：**轻页面 Obscura 优势巨大**（内存约 1/8、启动快 3–4 倍，26MB vs 201MB 在同一档确实是「30MB 级」）；**重页面会反过来**（维基这种大文档它要 6.5s / 359MB，比 Chromium 慢 2 倍多、还多占 127MB）。另外 Chromium 会派生 renderer/GPU 子进程（实测 11 个进程合计 331MB），Obscura 是单进程，所以上表的差距在实际整机占用上还要再放大一些。

### 复现

```bash
# 逐档对比（需要 crw 在 38210 跑着，browser 档读 state 里的路径）
node bench/compare.mjs
node bench/compare.mjs --urls https://example.com --repeat 3 --only direct,browser

# 换 Chromium 引擎再测一遍
BENCH_BROWSER_PATH=/Applications/Chromium.app/Contents/MacOS/Chromium node bench/compare.mjs
```

---

## 已知边界 / Known limits

- **知乎**：`robots.txt` 全站 `Disallow: /`，且网页版对非登录请求返回「安全验证」。任何抓取栈都拿不到正文；请用知乎开放平台 API（`dsh-free-search` 的 `zhihu_global` / `zhihu_site` 引擎）。
- **小红书**：同样全站 `Disallow: /`。
- **Cloudflare 强挑战**（npmjs 等）：`direct` / `jina` / `browser` 都过不了，`firecrawl` 可以，`crw` 需要把 Chrome CDP 挂上。
- **`lightpanda`**：官方明确禁止伪装 UA，中文站基本全挡；只适合当无反爬页的 markdown 预处理。
- **合规**：抓取前请遵守目标站 `robots.txt` 与服务条款；本插件默认不检查 `robots.txt`，那是调用方的责任。

---

## License

MIT —— 但 `crw` 二进制由 [fastcrw/crw](https://github.com/fastcrw/crw) 提供，遵循 **AGPL-3.0**，二者相互独立（本插件只是以子进程方式调用它）。

---

## 相关 / See also

- [DeepSeek Harness 插件开发文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)
- [fastCRW](https://github.com/fastcrw/crw)
- [Jina Reader](https://jina.ai/reader/)
- [firecrawl](https://firecrawl.dev/)
