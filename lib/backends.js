/**
 * Fetch backends for dsh--web-fetch.
 *
 * Every backend is a plain object:
 *   { id, label, description, homepage, needsKey, kind,
 *     available(ctx), fetch(url, ctx, signal) -> FetchResult }
 *
 * FetchResult = { url, statusCode, body: { kind: 'html' | 'text', content }, truncated }
 * which is exactly the contract `ctx.web.registerFetchProvider()` expects.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { findObscura, isObscura } from './obscura.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'

// Reused across requests: TLS handshakes dominate the cost of the cheap HTTP
// tiers, and keep-alive cuts a repeat request to the same origin roughly in
// half (measured 268ms -> 146ms on this machine).
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000 })

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

/** Markers that mean "we got a bot wall, not content". */
const CHALLENGE_RE = /(Just a moment|cf-challenge|Attention Required|Performing security verification|Verification successful|security service to protect against malicious bots|Enable JavaScript and cookies to continue|安全验证|访问过于频繁|环境异常|请完成验证|验证码|Access denied|Request blocked|Target URL returned error|Warning: This page maybe not yet fully loaded|您当前请求存在异常|请您登录后查看更多|网络环境存在异常|进入知乎|开始验证|请点击下方验证按钮|account\/unhuman|signin\?)/i

export function looksLikeChallenge(text) {
  if (!text) return true
  // Only the opening of a document is diagnostic. A long article that merely
  // mentions 验证码 or 安全验证 halfway through is not a challenge page.
  const head = text.slice(0, 1200)
  if (CHALLENGE_RE.test(head)) return true
  // Very short documents that match anywhere are still challenge stubs.
  return text.length < 3000 && CHALLENGE_RE.test(text)
}

/** Minimal HTTP(S) client with redirects, browser-ish headers, timeouts. */
export function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    maxRedirects = 5,
    signal,
    maxBytes = 8 * 1024 * 1024,
  } = options

  return new Promise((resolve, reject) => {
    let current
    try { current = new URL(url) } catch (err) { reject(new Error(`invalid url: ${url}`)); return }
    let hops = 0

    const go = (target) => {
      const mod = target.protocol === 'http:' ? http : https
      const req = mod.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'accept-encoding': 'identity',
          ...headers,
        },
        timeout: timeoutMs,
        agent: target.protocol === 'http:' ? httpAgent : httpsAgent,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          if (++hops > maxRedirects) { reject(new Error(`too many redirects (>${maxRedirects})`)); return }
          let next
          try { next = new URL(res.headers.location, target) } catch { reject(new Error('bad redirect location')); return }
          // only follow same-scheme to keep behaviour predictable
          go(next)
          return
        }
        const chunks = []
        let size = 0
        let truncated = false
        res.on('data', (c) => {
          size += c.length
          if (size > maxBytes) { truncated = true; res.destroy(); return }
          chunks.push(c)
        })
        res.on('end', () => resolve({
          url: target.toString(),
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          truncated,
        }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
      if (signal) {
        if (signal.aborted) { req.destroy(new Error('aborted')); return }
        signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      }
      if (body) req.write(body)
      req.end()
    }
    go(current)
  })
}

function isTextual(headers) {
  const ct = String(headers?.['content-type'] || '').toLowerCase()
  if (!ct) return true
  return /text\/|json|xml|javascript|xhtml/.test(ct)
}

function ok(res, minChars = 300) {
  return res.statusCode < 400 && isTextual(res.headers) && res.text.length >= minChars && !looksLikeChallenge(res.text)
}

/* ------------------------------------------------------------------ */
/* direct                                                              */
/* ------------------------------------------------------------------ */
const direct = {
  id: 'direct',
  label: '直连 HTTP',
  description: '进程内直接发 HTTP 请求，零依赖、零额外开销。适合静态页、API、RSS。',
  homepage: '',
  needsKey: false,
  kind: 'http',
  available: () => true,
  async fetch(url, ctx, signal) {
    const res = await httpRequest(url, { timeoutMs: ctx.timeouts.direct, signal })
    if (!ok(res)) throw new Error(`direct: HTTP ${res.statusCode}, ${res.text.length}B${looksLikeChallenge(res.text) ? ' (challenge page)' : ''}`)
    return {
      url: res.url,
      statusCode: res.statusCode,
      body: { kind: isTextual(res.headers) && /json|xml/.test(String(res.headers?.['content-type'] || '')) ? 'text' : 'html', content: res.text },
      truncated: res.truncated,
    }
  },
}

/* ------------------------------------------------------------------ */
/* jina reader (keyless)                                               */
/* ------------------------------------------------------------------ */
const jina = {
  id: 'jina',
  label: 'Jina Reader',
  description: 'r.jina.ai 免 key 公共阅读器，把任意页面清洗成 Markdown。对知乎专栏等登录墙页面常常有效。',
  homepage: 'https://jina.ai/reader/',
  needsKey: false,
  kind: 'reader',
  available: () => true,
  async fetch(url, ctx, signal) {
    const target = `https://r.jina.ai/${url}`
    const res = await httpRequest(target, {
      timeoutMs: ctx.timeouts.jina,
      signal,
      headers: { accept: 'text/markdown', 'x-respond-with': 'markdown' },
    })
    if (res.statusCode >= 400) throw new Error(`jina: HTTP ${res.statusCode}`)
    const text = res.text
      .replace(/^Title:.*\n?/m, '')
      .replace(/^URL Source:.*\n?/m, '')
      .replace(/^Markdown Content:\s*/m, '')
    if (text.trim().length < 120 || looksLikeChallenge(text)) throw new Error(`jina: short or challenge page (${text.length}B)`)
    return { url, statusCode: res.statusCode, body: { kind: 'text', content: text }, truncated: res.truncated }
  },
}

/* ------------------------------------------------------------------ */
/* firecrawl                                                           */
/* ------------------------------------------------------------------ */
const firecrawl = {
  id: 'firecrawl',
  label: 'firecrawl',
  description: '云端抓取 API，自带反爬与 JS 渲染，输出 Markdown。需要 FIRECRAWL_API_KEY。',
  homepage: 'https://firecrawl.dev/',
  needsKey: true,
  kind: 'cloud',
  available: (ctx) => Boolean(ctx.keys.firecrawl),
  async fetch(url, ctx, signal) {
    const body = JSON.stringify({ url, formats: ['markdown'], onlyMainContent: false })
    const res = await httpRequest('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      timeoutMs: ctx.timeouts.firecrawl,
      signal,
      body,
      headers: {
        authorization: `Bearer ${ctx.keys.firecrawl}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    })
    if (res.statusCode >= 400) throw new Error(`firecrawl: HTTP ${res.statusCode} ${res.text.slice(0, 160)}`)
    let json
    try { json = JSON.parse(res.text) } catch { throw new Error('firecrawl: non-JSON response') }
    const md = json?.data?.markdown ?? json?.markdown ?? ''
    if (!json?.success || String(md).length < 80) throw new Error(`firecrawl: short content (${String(md).length}B)`)
    return { url, statusCode: 200, body: { kind: 'text', content: String(md) }, truncated: false }
  },
}

/* ------------------------------------------------------------------ */
/* exa contents                                                        */
/* ------------------------------------------------------------------ */
const exa = {
  id: 'exa',
  label: 'Exa Contents',
  description: 'Exa 的 /contents 接口，按 URL 取正文。需要 EXA_API_KEY。',
  homepage: 'https://exa.ai/',
  needsKey: true,
  kind: 'cloud',
  available: (ctx) => Boolean(ctx.keys.exa),
  async fetch(url, ctx, signal) {
    const res = await httpRequest('https://api.exa.ai/contents', {
      method: 'POST',
      timeoutMs: ctx.timeouts.exa,
      signal,
      body: JSON.stringify({ ids: [url], text: true }),
      headers: { 'x-api-key': ctx.keys.exa, 'content-type': 'application/json', accept: 'application/json' },
    })
    if (res.statusCode >= 400) throw new Error(`exa: HTTP ${res.statusCode} ${res.text.slice(0, 160)}`)
    let json
    try { json = JSON.parse(res.text) } catch { throw new Error('exa: non-JSON response') }
    const item = json?.results?.[0]
    const text = item?.text ?? ''
    if (String(text).length < 80) throw new Error(`exa: short content (${String(text).length}B)`)
    return { url, statusCode: 200, body: { kind: 'text', content: String(text) }, truncated: false }
  },
}

/* ------------------------------------------------------------------ */
/* crw (local fastCRW)                                                 */
/* ------------------------------------------------------------------ */
const crw = {
  id: 'crw',
  label: 'CRW（本地 fastCRW）',
  description: 'Rust 写的本地抓取服务，单二进制约 23MB。启用后由插件自动部署并拉起一个无鉴权的本地实例，能过部分 Cloudflare 站点。',
  homepage: 'https://github.com/fastcrw/crw',
  needsKey: false,
  kind: 'local',
  available: (ctx) => ctx.crw?.info().status === 'running' || ctx.crw?.hasBinary(),
  async fetch(url, ctx, signal) {
    const sup = ctx.crw
    if (!sup) throw new Error('crw: supervisor unavailable')
    if (sup.info().status !== 'running') await sup.start(signal)
    const res = await httpRequest(`${sup.baseURL}/v1/scrape`, {
      method: 'POST',
      timeoutMs: ctx.timeouts.crw,
      signal,
      body: JSON.stringify({ url, formats: ['markdown'] }),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    })
    let json = null
    try { json = JSON.parse(res.text) } catch {}
    if (!json?.success) throw new Error(`crw: ${json?.error || `HTTP ${res.statusCode}`}`)
    const md = json?.data?.markdown ?? ''
    if (String(md).length < 80) throw new Error(`crw: short content (${String(md).length}B)`)
    return { url, statusCode: 200, body: { kind: 'text', content: String(md) }, truncated: false }
  },
}

/* ------------------------------------------------------------------ */
/* headless browser (dump-dom)                                         */
/* ------------------------------------------------------------------ */
const BROWSER_CANDIDATES = [
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Thorium.app/Contents/MacOS/Thorium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

export function findBrowser(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of BROWSER_CANDIDATES) {
    try { if (existsSync(p)) return p } catch {}
  }
  return null
}

/**
 * Pick the browser engine to use for the `browser` backend.
 * Obscura (Rust, own renderer) wins over Chromium/Chrome when both exist,
 * because it needs no browser process tree and no --dump-dom quirks.
 * Returns { path, engine: 'obscura' | 'chromium' } or null.
 */
export function detectBrowser(explicit) {
  if (explicit && existsSync(explicit)) {
    return { path: explicit, engine: isObscura(explicit) ? 'obscura' : 'chromium' }
  }
  const obs = findObscura('')
  if (obs) return { path: obs, engine: 'obscura' }
  const chrome = findBrowser('')
  if (chrome) return { path: chrome, engine: 'chromium' }
  return null
}

function dumpDom(binary, url, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    // NOTE: deliberately no --user-data-dir. On several Chrome for Testing
    // builds the combination `--headless=new --dump-dom --user-data-dir` never
    // exits (chromium issue 547894779), which turns every fetch into a timeout.
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-breakpad',
      '--disable-crashpad',
      '--disable-component-update',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--virtual-time-budget=8000',
      '--dump-dom',
      url,
    ]
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: false })
    let out = ''
    let settled = false
    const finish = (err, value) => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      err ? reject(err) : resolve(value)
    }
    child.stdout.on('data', (d) => { out += d.toString() })
    child.on('error', (err) => finish(err))
    child.on('exit', () => finish(null, out))
    const timer = setTimeout(() => finish(new Error(`browser: timeout after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    if (signal) signal.addEventListener('abort', () => finish(new Error('aborted')), { once: true })
  })
}

function runObscura(binary, url, timeoutMs, signal, { stealth = false } = {}) {
  const seconds = Math.max(3, Math.round(timeoutMs / 1000))
  const baseArgs = ['fetch', url, '--dump', 'markdown', '--timeout', String(seconds), '--allow-private-network', '--quiet']
  const env = { ...process.env, OBSCURA_ALLOW_PRIVATE_NETWORK: '1' }

  const attempt = (args) => new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    let errText = ''
    let settled = false
    const finish = (err, value) => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      err ? reject(err) : resolve(value)
    }
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { errText += d.toString() })
    child.on('error', (e) => finish(e))
    child.on('exit', (code) => {
      if (code === 0 && out) finish(null, out)
      else finish(new Error(`obscura exited ${code}: ${errText.slice(-300)}`))
    })
    const timer = setTimeout(() => finish(new Error(`browser: obscura timeout after ${timeoutMs}ms`)), timeoutMs + 2000)
    timer.unref?.()
    if (signal) signal.addEventListener('abort', () => finish(new Error('aborted')), { once: true })
  })

  return attempt(stealth ? [...baseArgs, '--stealth'] : baseArgs).catch((err) => {
    // Older/no-stealth builds reject the flag; retry once without it.
    if (stealth && /unexpected argument|unknown flag|unrecognized/i.test(err.message)) return attempt(baseArgs)
    throw err
  })
}

const browser = {
  id: 'browser',
  label: '无头浏览器',
  description: '默认用 Obscura（Rust 自渲染引擎，无需 Chromium）；也可指向本机 Chromium/Chrome 走 --dump-dom。路径可在设置里改。',
  homepage: 'https://github.com/h4ckf0r0day/obscura',
  needsKey: false,
  kind: 'local',
  available: (ctx) => Boolean(detectBrowser(ctx.browserPath)),
  async fetch(url, ctx, signal) {
    const target = detectBrowser(ctx.browserPath)
    if (!target) throw new Error('browser: no obscura / Chromium / Chrome found')
    const isObscuraEngine = target.engine === 'obscura'
    const content = isObscuraEngine
      ? await runObscura(target.path, url, ctx.timeouts.browser, signal, { stealth: ctx.browserStealth !== false })
      : await dumpDom(target.path, url, ctx.timeouts.browser, signal)
    if (!content || content.length < 300 || looksLikeChallenge(content)) {
      throw new Error(`browser: short or challenge page (${content?.length ?? 0}B)`)
    }
    return { url, statusCode: 200, body: { kind: isObscuraEngine ? 'text' : 'html', content }, truncated: false }
  },
}

/* ------------------------------------------------------------------ */
/* lightpanda (optional)                                               */
/* ------------------------------------------------------------------ */
const LIGHTPANDA_CANDIDATES = [
  join(process.env.HOME || '', '.dsh', 'dsh-web-fetch', 'bin', 'lightpanda'),
  '/usr/local/bin/lightpanda',
  '/opt/homebrew/bin/lightpanda',
]

export function findLightpanda(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of LIGHTPANDA_CANDIDATES) {
    try { if (p && existsSync(p)) return p } catch {}
  }
  return null
}

const lightpanda = {
  id: 'lightpanda',
  label: 'Lightpanda',
  description: 'Zig 写的超轻量无头浏览器，速度快、内存小；不支持指纹伪装，中文站点常被拦。适合当 Markdown 预处理层。',
  homepage: 'https://github.com/lightpanda-io/browser',
  needsKey: false,
  kind: 'local',
  available: (ctx) => Boolean(findLightpanda(ctx.lightpandaPath)),
  async fetch(url, ctx, signal) {
    const bin = findLightpanda(ctx.lightpandaPath)
    if (!bin) throw new Error('lightpanda: binary not found')
    const md = await new Promise((resolve, reject) => {
      const child = spawn(bin, ['fetch', '--dump', 'markdown', url], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      let settled = false
      const finish = (err, v) => { if (settled) return; settled = true; try { child.kill('SIGKILL') } catch {}; err ? reject(err) : resolve(v) }
      child.stdout.on('data', (d) => { out += d.toString() })
      child.on('error', finish)
      child.on('exit', () => finish(null, out))
      const timer = setTimeout(() => finish(new Error('lightpanda: timeout')), ctx.timeouts.lightpanda)
      timer.unref?.()
      if (signal) signal.addEventListener('abort', () => finish(new Error('aborted')), { once: true })
    })
    if (!md || md.length < 80) throw new Error(`lightpanda: short content (${md?.length ?? 0}B)`)
    return { url, statusCode: 200, body: { kind: 'text', content: md }, truncated: false }
  },
}


/* ------------------------------------------------------------------ */
/* cdp — drive a real Chrome over the DevTools protocol                */
/* ------------------------------------------------------------------ */
/**
 * The last-resort local browser tier. Unlike `browser` (which spawns a fresh
 * process per URL and dies), this keeps ONE Chrome alive with a persistent
 * profile, so cookies / logins survive between calls — which is the only way
 * past login walls like Zhihu. It talks raw CDP (no Playwright), which also
 * removes the automation-protocol fingerprint that Playwright adds.
 *
 * It is still a datacenter IP on this machine, so it will NOT beat a strong
 * Cloudflare challenge; use a cloud unblocker for that.
 */
const cdpState = { child: null, port: 0, profile: '' }

function cdpBase(port) { return `http://127.0.0.1:${port}` }

async function cdpJson(port, path, timeoutMs = 1500) {
  const res = await fetch(`${cdpBase(port)}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}

async function waitForCdp(port, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { const v = await cdpJson(port, '/json/version'); if (v?.webSocketDebuggerUrl) return v } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('cdp: Chrome did not expose a DevTools endpoint in time')
}

async function ensureChrome(ctx) {
  const port = ctx.cdp?.port ?? 9333
  if (cdpState.child && cdpState.port === port) {
    try { await cdpJson(port, '/json/version'); return port } catch { try { cdpState.child.kill('SIGKILL') } catch {}; cdpState.child = null }
  }
  try { await cdpJson(port, '/json/version'); cdpState.port = port; return port } catch {}
  const found = findBrowser(ctx.browserPath)
  if (!found) throw new Error('cdp: no Chromium/Chrome binary found')
  const profile = ctx.cdp?.userDataDir || join(ctx.dataDir || tmpdir(), 'chrome-profile')
  try { mkdirSync(profile, { recursive: true }) } catch {}
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    'about:blank',
  ]
  const child = spawn(found, args, { stdio: 'ignore', detached: false })
  child.on('exit', () => { if (cdpState.child === child) { cdpState.child = null } })
  cdpState.child = child
  cdpState.port = port
  cdpState.profile = profile
  await waitForCdp(port, 20000)
  return port
}

/** Minimal flattened-session CDP RPC over the global WebSocket. */
async function withCdp(port, fn, timeoutMs) {
  const version = await cdpJson(port, '/json/version')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', (e) => reject(new Error(`cdp: websocket error`)), { once: true })
  })
  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(`cdp: ${msg.error.message}`)) : resolve(msg.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp: ${method} timed out`)) }, timeoutMs)
    timer.unref?.()
  })
  try {
    await opened
    return await fn(send)
  } finally {
    try { ws.close() } catch {}
  }
}

const cdp = {
  id: 'cdp',
  label: 'Chrome CDP（持久登录态）',
  description: '常驻一个真实 Chrome，用原始 DevTools 协议取 DOM（不经 Playwright）；独立 profile，登录态可复用，适合登录墙站点。会占 300–400MB。',
  homepage: 'https://chromedevtools.github.io/devtools-protocol/',
  needsKey: false,
  kind: 'browser',
  available: (ctx) => Boolean(findBrowser(ctx?.browserPath)),
  async fetch(url, ctx, signal) {
    const timeout = ctx.timeouts?.cdp ?? 45000
    const port = await ensureChrome(ctx)
    const html = await withCdp(port, async (send) => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      try {
        await send('Page.enable', {}, sessionId)
        await send('Page.navigate', { url }, sessionId)
        const end = Date.now() + timeout
        let text = ''
        while (Date.now() < end) {
          if (signal?.aborted) throw new Error('aborted')
          await new Promise((r) => setTimeout(r, 250))
          try {
            const r = await send('Runtime.evaluate', {
              expression: 'JSON.stringify({ready: document.readyState, len: (document.body && document.body.innerText || "").length})',
              returnByValue: true,
            }, sessionId)
            const info = JSON.parse(r?.result?.value || '{}')
            if (info.ready === 'complete' && info.len > 0) {
              const out = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId)
              text = out?.result?.value || ''
              if (text.length > 200) break
            }
          } catch {}
        }
        return text
      } finally {
        try { await send('Target.closeTarget', { targetId }) } catch {}
      }
    }, timeout)
    if (!html || html.length < 80) throw new Error(`cdp: short content (${html?.length ?? 0}B)`)
    if (looksLikeChallenge(html)) throw new Error('cdp: challenge page')
    return { url, statusCode: 200, body: { kind: 'html', content: html }, truncated: false }
  },
}

export const ALL_BACKENDS = [direct, jina, firecrawl, exa, crw, browser, cdp, lightpanda]

export const BACKEND_BY_ID = Object.fromEntries(ALL_BACKENDS.map((b) => [b.id, b]))

export const DEFAULT_ORDER = ['direct', 'jina', 'firecrawl', 'crw', 'exa', 'browser', 'cdp', 'lightpanda']

export function readFileSafe(path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

export function makeTempDir(prefix = 'dsh-web-fetch-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
