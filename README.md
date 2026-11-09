# dsh--web-fetch

> 一个给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart) 用的**可编排网页抓取 provider**：把直连、Jina Reader、Firecrawl、fastCRW、Exa、无头浏览器、Lightpanda 串成一条**你可以拖动排序**的回退链。
>
> An **orchestratable web-fetch provider** for DeepSeek Harness: direct HTTP, Jina Reader, Firecrawl, fastCRW, Exa, headless browser and Lightpanda, chained into a fallback order **you can drag to reorder**.

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
| **7 个抓取后端** | 直连 HTTP、Jina Reader（免 key）、Firecrawl、fastCRW、Exa、无头浏览器、Lightpanda |
| **拖动排序** | 插件卡片里 HTML5 拖拽调整回退顺序，实时写盘；每行另有 `↑` / `↓` 按钮，不方便拖拽时也能排序 |
| **逐项开关** | 每个后端单独启用/禁用；缺 key 或缺二进制的会自动跳过 |
| **连通性测试** | 输入 URL 一次跑完整条链，逐档显示耗时与字节数，失败附原因 |
| **质量闸门** | 结果短于阈值时不算成功，会继续尝试下一档；全部偏短则返回最长的一份 |
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
| `firecrawl` | Firecrawl v2 | `FIRECRAWL_API_KEY` | 反爬站、Cloudflare | `POST /v2/scrape` → markdown，最稳的一档 |
| `crw` | fastCRW 本地 | 无（自动下载） | 想要自托管、不想用云 API | 见下节 |
| `exa` | Exa Contents | `EXA_API_KEY` | 语义检索配套抓取 | `POST /contents` |
| `browser` | 无头浏览器 | 本机 Chrome/Chromium | 需要 JS 渲染的页 | `--dump-dom`，**故意不加 `--user-data-dir`**（见下） |
| `lightpanda` | Lightpanda | 本机 `lightpanda` 二进制 | markdown 预处理 | 快但中文站基本全挡，不建议当主力 |

### 质量闸门 / Quality gate

一档返回的正文短于 `minChars.accept`（默认 400 字符）时不算成功，继续试下一档；如果全部偏短，则在短于 `minChars.floor`（默认 80）时硬失败，否则返回最长的一份 —— 这样既不会把「Just a moment…」当正文，也不会让一个真的只有一句话的页面直接报错。

### 关于无头浏览器 / About the browser tier

`--headless=new --dump-dom` 与 `--user-data-dir` 同时出现时，Chromium 会在输出完 DOM 后**不退出**（[Chromium issue 547894779](https://issues.chromium.org/issues/547894779)）。所以本插件调用 `--dump-dom` 时**不传** `--user-data-dir`，避免了「等到超时」的老问题。如果你需要登录态，请改用 CRW + 常驻 CDP（见下）。

---

## CRW：本地无鉴权部署 / Local unauthenticated CRW

[fastCRW](https://github.com/fastcrw/crw) 是一个 Rust 写的单文件爬虫服务（Firecrawl 兼容 API，AGPL-3.0）。

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
    browserPath: ""            # 留空自动探测 Chromium / Chrome / Thorium / Edge
    lightpandaPath: ""         # 留空从 PATH 找 lightpanda
```

### API Key 解析顺序 / Key resolution

1. DSH `credentials` 服务（若可用）
2. `~/.dsh/.credentials.yaml` 里的 `FIRECRAWL_API_KEY` / `EXA_API_KEY`
3. 进程环境变量 `FIRECRAWL_API_KEY` / `EXA_API_KEY`

---

## HTTP 接口 / Bridge API

插件在 DSH 的 web server 上注册了这些路由（供卡片使用，也可以直接用）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-web-fetch/state` | 当前状态：顺序、开关、后端可用性、CRW 状态 |
| POST | `/api/dsh-web-fetch/order` | `{ order: ["direct", ...] }` |
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
- [Firecrawl](https://firecrawl.dev/)
