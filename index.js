/**
 * dsh--web-fetch — an aggregated web-fetch provider for DeepSeek Harness.
 *
 * Registers a fetch provider (`id: "dsh-web-fetch"`) that walks a
 * user-defined, drag-orderable fallback chain across several fetch backends
 * (direct HTTP, Jina Reader, Firecrawl, Exa, local CRW, headless browser,
 * Lightpanda). Enabling the `crw` tier automatically deploys and starts a
 * local, unauthenticated fastCRW instance.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ALL_BACKENDS,
  BACKEND_BY_ID,
  DEFAULT_ORDER,
  httpRequest,
  findBrowser,
  findLightpanda,
  detectBrowser,
} from './lib/backends.js'
import { CrwSupervisor } from './lib/crw.js'
import { ObscuraManager, findObscura, managedBinaryPath } from './lib/obscura.js'

export const name = 'dsh--web-fetch'
export const inject = ['web']

const PROVIDER_ID = 'dsh-web-fetch'
const API_PREFIX = '/api/dsh-web-fetch'
const STATE_VERSION = 1

/* ------------------------------------------------------------------ */
/* paths & state                                                       */
/* ------------------------------------------------------------------ */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function stateDir() {
  return join(dshHome(), 'dsh-web-fetch')
}

function statePath() {
  return join(stateDir(), 'state.json')
}

function keysPath() {
  return join(stateDir(), 'keys.json')
}

/** Plugin-local API keys. Stored 0600 so they never leak into the repo. */
function loadPluginKeys() {
  try {
    const raw = readFileSync(keysPath(), 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function savePluginKeys(keys) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(keysPath(), JSON.stringify(keys, null, 2), { mode: 0o600 })
  try { chmodSync(keysPath(), 0o600) } catch {}
  return keys
}

function maskKey(value) {
  if (!value) return ''
  if (value.length <= 8) return '••••'
  return `••••${value.slice(-4)}`
}

function defaultState(config = {}) {
  return {
    version: STATE_VERSION,
    order: Array.isArray(config.order) && config.order.length ? config.order.filter((id) => BACKEND_BY_ID[id]) : [...DEFAULT_ORDER],
    enabled: Object.fromEntries(ALL_BACKENDS.map((b) => [b.id, defaultEnabled(b.id, config)])),
    crw: {
      autoStart: config.crw?.autoStart !== false,
      port: config.crw?.port ?? 38210,
      host: config.crw?.host || '127.0.0.1',
      version: config.crw?.version || 'v0.43.1',
      autoDownload: config.crw?.autoDownload !== false,
      binaryPath: config.crw?.binaryPath || '',
      rendererMode: config.crw?.rendererMode || 'auto',
      chromeWsUrl: config.crw?.chromeWsUrl || '',
    },
    timeouts: {
      direct: config.timeouts?.direct ?? 20000,
      jina: config.timeouts?.jina ?? 25000,
      firecrawl: config.timeouts?.firecrawl ?? 40000,
      exa: config.timeouts?.exa ?? 30000,
      crw: config.timeouts?.crw ?? 60000,
      browser: config.timeouts?.browser ?? 20000,
      lightpanda: config.timeouts?.lightpanda ?? 25000,
    },
    minChars: { accept: config.minChars?.accept ?? 400, floor: config.minChars?.floor ?? 80 },
    browserPath: config.browserPath || '',
    browserEngine: config.browserEngine || 'auto',
    browserStealth: config.browserStealth !== false,
    obscura: {
      version: config.obscura?.version || 'v0.2.6',
      autoDownload: config.obscura?.autoDownload !== false,
      stealth: config.obscura?.stealth !== false,
      binaryPath: config.obscura?.binaryPath || '',
    },
    lightpandaPath: config.lightpandaPath || '',
  }
}

function defaultEnabled(id, config) {
  if (config.enabled && typeof config.enabled[id] === 'boolean') return config.enabled[id]
  // On by default: the cheap, dependency-free tiers plus every tier that has a
  // credential available. `browser` and `lightpanda` are opt-in because they
  // spawn processes.
  if (id === 'browser' || id === 'lightpanda') return false
  if (id === 'crw') return config.crw?.autoStart !== false
  return true
}

function loadState(config) {
  const base = defaultState(config)
  try {
    const raw = readFileSync(statePath(), 'utf8')
    const saved = JSON.parse(raw)
    if (saved?.version === STATE_VERSION) {
      const order = Array.isArray(saved.order) ? saved.order.filter((id) => BACKEND_BY_ID[id]) : base.order
      return {
        ...base,
        ...saved,
        order: [...order, ...base.order.filter((id) => !order.includes(id))],
        enabled: { ...base.enabled, ...(saved.enabled || {}) },
        crw: { ...base.crw, ...(saved.crw || {}) },
        timeouts: { ...base.timeouts, ...(saved.timeouts || {}) },
      }
    }
  } catch {}
  return base
}

function saveState(state) {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`)
}

/* ------------------------------------------------------------------ */
/* API keys                                                            */
/* ------------------------------------------------------------------ */
/**
 * Resolve a secret from, in order: the DSH credentials service (if present),
 * a plain-text ~/.dsh/.credentials.yaml, then process.env.
 */
function makeKeyResolver(ctx) {
  let credsCache = null
  const readCredFile = () => {
    if (credsCache) return credsCache
    const map = {}
    const paths = [join(dshHome(), '.credentials.yaml'), join(dshHome(), 'credentials.yaml')]
    for (const p of paths) {
      if (!existsSync(p)) continue
      let text = ''
      try { text = readFileSync(p, 'utf8') } catch { continue }
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*([A-Z][A-Z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line)
        if (!m) continue
        let v = m[2]
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        if (v && v !== 'null') map[m[1]] = v
      }
    }
    credsCache = map
    return map
  }

  const fromService = (envName) => {
    try {
      const svc = ctx.get('credentials')
      const v = svc?.resolve?.(envName)
      if (typeof v === 'string' && v) return v
      if (v && typeof v.value === 'string' && v.value) return v.value
    } catch {}
    return ''
  }

  const localKeyFor = (envName) => {
    const map = { FIRECRAWL_API_KEY: 'firecrawl', EXA_API_KEY: 'exa', JINA_API_KEY: 'jina', TAVILY_API_KEY: 'tavily' }
    const id = map[envName]
    if (!id) return ''
    const v = loadPluginKeys()[id]
    return typeof v === 'string' ? v : ''
  }

  return (envName) => localKeyFor(envName) || fromService(envName) || readCredFile()[envName] || process.env[envName] || ''
}

/* ------------------------------------------------------------------ */
/* the provider                                                        */
/* ------------------------------------------------------------------ */
function createProvider(state, ctx2) {
  return {
    id: PROVIDER_ID,
    available() {
      return true
    },
    async fetch(request, signal) {
      const url = typeof request === 'string' ? request : request?.url
      if (!url) throw new Error('dsh-web-fetch: missing url')
      const errors = []
      const soft = []
      const minChars = state.minChars?.accept ?? 400
      const hardMin = state.minChars?.floor ?? 80
      const chain = state.order.filter((id) => state.enabled[id] !== false && BACKEND_BY_ID[id])
      for (const id of chain) {
        const backend = BACKEND_BY_ID[id]
        let available = false
        try { available = backend.available(ctx2) } catch { available = false }
        if (!available) { errors.push(`${id}: unavailable`); continue }
        try {
          const res = await backend.fetch(url, ctx2, signal)
          const size = res?.body?.content?.length ?? 0
          if (!size) { errors.push(`${id}: empty result`); continue }
          if (size >= minChars) {
            ctx2.log?.(`[dsh-web-fetch] ${id} ok ${url} (${size}B)`)
            return res
          }
          // Too thin to be useful, but keep it in case every tier is thin: a
          // genuinely tiny page is still better than a hard failure.
          soft.push({ id, res, size })
          errors.push(`${id}: too short (${size}B < ${minChars}B)`)
        } catch (err) {
          if (signal?.aborted) throw err
          errors.push(`${id}: ${err.message}`)
        }
      }
      if (soft.length) {
        const best = soft.sort((a, b) => b.size - a.size)[0]
        if (best.size >= hardMin) {
          ctx2.log?.(`[dsh-web-fetch] ${best.id} best-effort ${url} (${best.size}B)`)
          return best.res
        }
      }
      throw new Error(`${PROVIDER_ID}: could not fetch ${url} (${errors.join('; ') || 'no backend enabled'})`)
    },
  }
}

/* ------------------------------------------------------------------ */
/* tiny http helpers for the bridge API                                */
/* ------------------------------------------------------------------ */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  })
  res.end(html)
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */
export function apply(ctx, config = {}) {
  const log = (msg) => {
    try { ctx.logger?.info?.(msg) } catch {}
  }
  const state = loadState(config)
  const resolveKey = makeKeyResolver(ctx)

  const supervisor = new CrwSupervisor({
    stateDir: stateDir(),
    binaryPath: state.crw.binaryPath || join(stateDir(), 'bin', 'crw-server'),
    port: state.crw.port,
    host: state.crw.host,
    version: state.crw.version,
    autoDownload: state.crw.autoDownload,
    rendererMode: state.crw.rendererMode,
    chromeWsUrl: state.crw.chromeWsUrl,
    log,
  })

  const obscuraManager = new ObscuraManager({ state, log })

  const runtime = {
    keys: {
      firecrawl: resolveKey('FIRECRAWL_API_KEY'),
      exa: resolveKey('EXA_API_KEY'),
      jina: resolveKey('JINA_API_KEY'),
      tavily: resolveKey('TAVILY_API_KEY'),
    },
    timeouts: state.timeouts,
    crw: supervisor,
    browserPath: state.browserPath,
    browserStealth: state.browserStealth,
    obscura: obscuraManager,
    lightpandaPath: state.lightpandaPath,
    log,
  }

  // refresh keys lazily on every access so a credential rotation is picked up
  const runtimeProxy = new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'keys') {
        return {
          firecrawl: resolveKey('FIRECRAWL_API_KEY'),
          exa: resolveKey('EXA_API_KEY'),
          jina: resolveKey('JINA_API_KEY'),
          tavily: resolveKey('TAVILY_API_KEY'),
        }
      }
      return target[prop]
    },
  })

  ctx.effect(() => {
    const provider = createProvider(state, runtimeProxy)
    const dispose = ctx.web.registerFetchProvider(provider)
    log(`[dsh-web-fetch] provider registered as "${PROVIDER_ID}"`)
    return () => {
      try { typeof dispose === 'function' ? dispose() : dispose?.dispose?.() } catch {}
    }
  }, 'dsh-web-fetch: provider')

  // crw lifecycle: start when the tier is enabled (the plugin's whole point is
  // that enabling crw == a working local CRW deployment, without extra steps).
  ctx.effect(() => {
    let cancelled = false
    if (state.enabled.crw && state.crw.autoStart) {
      supervisor.start().catch((err) => log(`[dsh-web-fetch] crw autostart failed: ${err.message}`))
    }
    return () => {
      cancelled = true
      supervisor.stop().catch(() => {})
    }
  }, 'dsh-web-fetch: crw')

  /* ---------------- bridge API ---------------- */
  const publicState = () => ({
    providerId: PROVIDER_ID,
    statePath: statePath(),
    stateDir: stateDir(),
    order: state.order,
    enabled: state.enabled,
    crw: { ...supervisor.info(), autoStart: state.crw.autoStart },
    keys: Object.fromEntries(
      Object.entries({ firecrawl: 'FIRECRAWL_API_KEY', exa: 'EXA_API_KEY', jina: 'JINA_API_KEY', tavily: 'TAVILY_API_KEY' }).map(([id, env]) => {
        const local = loadPluginKeys()[id] || ''
        const resolved = resolveKey(env)
        return [id, {
          configured: Boolean(resolved),
          source: local ? 'plugin' : resolved ? 'external' : '',
          mask: maskKey(resolved),
        }]
      }),
    ),
    browser: {
      path: state.browserPath || '',
      engine: state.browserEngine || 'auto',
      stealth: state.browserStealth !== false,
      detected: detectBrowser(state.browserPath),
      obscura: { ...obscuraManager.info(), managedPath: managedBinaryPath() },
    },
    backends: ALL_BACKENDS.map((b) => {
      let available = false
      let reason = ''
      try { available = b.available(runtimeProxy) } catch (err) { reason = err.message }
      if (!available && !reason) reason = b.needsKey ? '缺少 API Key' : '本机未找到所需程序'
      return {
        id: b.id,
        label: b.label,
        description: b.description,
        homepage: b.homepage,
        needsKey: b.needsKey,
        kind: b.kind,
        available,
        reason,
        enabled: state.enabled[b.id] !== false,
      }
    }),
  })

  const routes = [
    {
      kind: 'exact',
      path: `${API_PREFIX}/state`,
      handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        sendJson(res, 200, publicState())
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/keys`,
      async handler(req, res) {
        if (req.method === 'GET') return sendJson(res, 200, publicState().keys)
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const id = String(body.id || '')
          if (!['firecrawl', 'exa', 'jina', 'tavily'].includes(id)) return sendJson(res, 400, { error: `unknown key id: ${id}` })
          const keys = loadPluginKeys()
          const value = typeof body.value === 'string' ? body.value.trim() : ''
          if (value) keys[id] = value
          else delete keys[id]
          savePluginKeys(keys)
          sendJson(res, 200, publicState().keys)
        } catch (err) {
          sendJson(res, 400, { error: err.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/config`,
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          if (typeof body.browserPath === 'string') state.browserPath = body.browserPath.trim()
          if (typeof body.browserEngine === 'string') state.browserEngine = body.browserEngine
          if (typeof body.browserStealth === 'boolean') state.browserStealth = body.browserStealth
          if (body.timeouts && typeof body.timeouts === 'object') {
            for (const [k, v] of Object.entries(body.timeouts)) {
              if (k in state.timeouts && Number.isFinite(Number(v))) state.timeouts[k] = Number(v)
            }
          }
          saveState(state)
          sendJson(res, 200, publicState())
        } catch (err) {
          sendJson(res, 400, { error: err.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/browser`,
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const action = String(body.action || 'detect')
          if (action === 'detect') {
            const found = detectBrowser(state.browserPath)
            return sendJson(res, 200, { ok: Boolean(found), detected: found, obscura: obscuraManager.info() })
          }
          if (action === 'download') {
            const bin = await obscuraManager.ensureBinary({ stealth: state.browserStealth !== false, force: Boolean(body.force) })
            state.browserPath = bin
            saveState(state)
            return sendJson(res, 200, { ok: true, detected: detectBrowser(bin), obscura: obscuraManager.info() })
          }
          if (action === 'test') {
            const url = String(body.url || 'https://example.com')
            const backend = BACKEND_BY_ID.browser
            const started = Date.now()
            const out = await backend.fetch(url, runtimeProxy, undefined)
            return sendJson(res, 200, { ok: true, ms: Date.now() - started, bytes: out.body.content.length, engine: detectBrowser(state.browserPath)?.engine })
          }
          return sendJson(res, 400, { error: `unknown action: ${action}` })
        } catch (err) {
          sendJson(res, 500, { error: err.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/order`,
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const next = Array.isArray(body.order) ? body.order.filter((id) => BACKEND_BY_ID[id]) : null
          if (!next || !next.length) return sendJson(res, 400, { error: 'order must be a non-empty array of backend ids' })
          state.order = [...next, ...DEFAULT_ORDER.filter((id) => !next.includes(id))]
          saveState(state)
          sendJson(res, 200, publicState())
        } catch (err) {
          sendJson(res, 400, { error: err.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/toggle`,
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const id = String(body.id || '')
          if (!BACKEND_BY_ID[id]) return sendJson(res, 400, { error: `unknown backend: ${id}` })
          state.enabled[id] = Boolean(body.enabled)
          if (id === 'crw') state.crw.autoStart = state.enabled[id]
          saveState(state)
          if (id === 'crw') {
            if (state.enabled[id]) {
              supervisor.start().catch((err) => log(`[dsh-web-fetch] crw start failed: ${err.message}`))
            } else {
              supervisor.stop().catch(() => {})
            }
          }
          sendJson(res, 200, publicState())
        } catch (err) {
          sendJson(res, 400, { error: err.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/crw`,
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const action = String(body.action || '')
          if (action === 'start') await supervisor.start()
          else if (action === 'stop') await supervisor.stop()
          else if (action === 'restart') await supervisor.restart()
          else return sendJson(res, 400, { error: 'action must be start | stop | restart' })
          sendJson(res, 200, publicState())
        } catch (err) {
          sendJson(res, 500, { error: err.message, crw: supervisor.info() })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/test`,
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = JSON.parse(await readBody(req))
          const url = String(body.url || '')
          if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'url must start with http:// or https://' })
          const only = body.id ? String(body.id) : ''
          const chain = only ? [only] : state.order.filter((id) => state.enabled[id] !== false)
          const results = []
          for (const id of chain) {
            const backend = BACKEND_BY_ID[id]
            if (!backend) continue
            let usable = false
            try { usable = backend.available(runtimeProxy) } catch { usable = false }
            if (!usable) {
              results.push({ id, ok: false, skipped: true, ms: 0, error: backend.needsKey ? '缺少 API Key（已跳过）' : '本机未找到所需程序（已跳过）' })
              continue
            }
            const started = Date.now()
            try {
              const r = await backend.fetch(url, runtimeProxy)
              results.push({ id, ok: true, ms: Date.now() - started, bytes: r.body.content.length, preview: r.body.content.slice(0, 400) })
            } catch (err) {
              results.push({ id, ok: false, ms: Date.now() - started, error: err.message })
            }
          }
          sendJson(res, 200, { url, results })
        } catch (err) {
          sendJson(res, 400, { error: err.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/ui`,
      handler(req, res) {
        sendHtml(res, 200, renderUiPage())
      },
    },
  ]

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const disposers = routes.map((route) => sctx.get('webServer').register(route))
      return () => {
        for (const d of disposers) {
          try { typeof d === 'function' ? d() : d?.dispose?.() } catch {}
        }
      }
    }, 'dsh-web-fetch: bridge')
  })

  /* ---------------- activation ---------------- */
  // Take over `web.fetchProvider` at runtime when it is unset or still the
  // shipped default (`http`). This mirrors how dsh-free-search claims the
  // search provider and avoids a static `- id: web / config:` line in the
  // bundle patch — a patch replaces the whole row config, so a static value
  // would leave a dangling provider reference whenever this plugin is disabled.
  ctx.inject(['settings'], (sctx) => {
    try {
      const ref = ctx.web.config?.fetchProvider
      const current = typeof ref?.get === 'function' ? ref.get() : ctx.web.fetchProviderId
      if (!current || current === 'http') {
        if (typeof ref?.get === 'function') {
          Promise.resolve(sctx.settings?.mutate?.('web', [{ op: 'set', path: ['fetchProvider'], value: PROVIDER_ID }]))
            .catch((err) => log(`[dsh-web-fetch] takeover failed: ${err?.message || err}`))
        } else {
          ctx.web.fetchProviderId = PROVIDER_ID
        }
        log(`[dsh-web-fetch] took over web.fetchProvider as "${PROVIDER_ID}"`)
      } else if (current !== PROVIDER_ID) {
        log(`[dsh-web-fetch] fetch is served by "${current}", not "${PROVIDER_ID}". Set this in the profile cordis.patch.yml (keep other web.* fields):\n- id: web\n  config:\n    fetchProvider: ${PROVIDER_ID}`)
      }
    } catch (err) {
      log(`[dsh-web-fetch] activation check skipped: ${err.message}`)
    }
  })
}

/* ------------------------------------------------------------------ */
/* standalone UI (also used as a fallback when the client card is not  */
/* available in a given DSH build)                                     */
/* ------------------------------------------------------------------ */
export function renderUiPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh--web-fetch · 抓取回退顺序</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; --accent:#2563eb; --ok:#059669; --bad:#dc2626; --warn:#d97706; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0d10; --fg:#e5e7eb; --muted:#9ca3af; --line:#262b33; --card:#14181d; --accent:#60a5fa; --ok:#34d399; --bad:#f87171; --warn:#fbbf24; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.sub { margin: 0 0 22px; color: var(--muted); }
  .panel { border:1px solid var(--line); background:var(--card); border-radius:12px; padding:14px 16px; margin-bottom:18px; }
  .panel h2 { font-size:13px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin:0 0 10px; }
  ol.list { list-style:none; margin:0; padding:0; }
  li.row { display:flex; align-items:center; gap:12px; padding:11px 12px; border:1px solid var(--line); background:var(--bg); border-radius:10px; margin-bottom:8px; cursor:grab; }
  li.row.dragging { opacity:.45; }
  li.row.over { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent); }
  .grip { color:var(--muted); font-size:16px; user-select:none; }
  .idx { width:22px; text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
  .main { flex:1; min-width:0; }
  .name { font-weight:600; }
  .desc { color:var(--muted); font-size:12px; margin-top:2px; }
  .tags { display:flex; gap:6px; margin-top:6px; flex-wrap:wrap; }
  .tag { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .tag.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 45%, transparent); }
  .tag.bad { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 45%, transparent); }
  .switch { position:relative; width:38px; height:22px; flex:none; }
  .switch input { opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
  .switch span { position:absolute; inset:0; border-radius:999px; background:var(--line); transition:.18s; pointer-events:none; }
  .switch span::after { content:""; position:absolute; width:16px; height:16px; border-radius:50%; background:#fff; top:3px; left:3px; transition:.18s; }
  .switch input:checked + span { background:var(--accent); }
  .switch input:checked + span::after { transform:translateX(16px); }
  button { font:inherit; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.5; cursor:default; }
  input[type=text] { flex:1; min-width:0; font:inherit; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .muted { color:var(--muted); }
  .status { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>dsh--web-fetch</h1>
  <p class="sub">拖动左侧手柄调整抓取回退顺序 · 顺序越靠前越先尝试 · 改动即时保存</p>

  <div class="panel">
    <h2>回退顺序</h2>
    <ol class="list" id="list"></ol>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button id="reset">恢复默认顺序</button>
      <button id="refresh">刷新</button>
    </div>
  </div>

  <div class="panel">
    <h2>CRW 本地实例</h2>
    <div class="status">
      <div id="crw-info" class="muted">读取中…</div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button id="crw-start">启动</button>
        <button id="crw-stop">停止</button>
        <button id="crw-restart">重启</button>
      </div>
    </div>
    <pre id="crw-detail" class="muted" style="margin-top:10px"></pre>
  </div>

  <div class="panel">
    <h2>连通性测试</h2>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <input type="text" id="test-url" placeholder="https://example.com" />
      <button class="primary" id="test-run">依次测试</button>
    </div>
    <pre id="test-out" class="muted">—</pre>
  </div>
</div>
<script>
(function () {
  var state = null;
  var listEl = document.getElementById('list');
  var dragId = null;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function render() {
    if (!state) return;
    listEl.innerHTML = '';
    state.order.forEach(function (id, i) {
      var b = state.backends.filter(function (x) { return x.id === id; })[0];
      if (!b) return;
      var li = el('li', 'row');
      li.draggable = true;
      li.dataset.id = id;
      li.appendChild(el('span', 'grip', '⠿'));
      li.appendChild(el('span', 'idx', String(i + 1)));
      var main = el('div', 'main');
      main.appendChild(el('div', 'name', b.label));
      main.appendChild(el('div', 'desc', b.description || ''));
      var tags = el('div', 'tags');
      tags.appendChild(el('span', 'tag ' + (b.available ? 'ok' : 'bad'), b.available ? '可用' : (b.reason || '不可用')));
      tags.appendChild(el('span', 'tag', b.kind));
      if (b.needsKey) tags.appendChild(el('span', 'tag', '需要 Key'));
      main.appendChild(tags);
      li.appendChild(main);
      var sw = el('label', 'switch');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = b.enabled;
      cb.addEventListener('change', function () { toggle(id, cb.checked); });
      sw.appendChild(cb); sw.appendChild(el('span'));
      li.appendChild(sw);

      li.addEventListener('dragstart', function (e) { dragId = id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
      li.addEventListener('dragend', function () { li.classList.remove('dragging'); Array.prototype.forEach.call(listEl.children, function (c) { c.classList.remove('over'); }); });
      li.addEventListener('dragover', function (e) { e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', function () { li.classList.remove('over'); });
      li.addEventListener('drop', function (e) {
        e.preventDefault(); li.classList.remove('over');
        if (!dragId || dragId === id) return;
        var order = state.order.slice();
        order.splice(order.indexOf(dragId), 1);
        order.splice(order.indexOf(id), 0, dragId);
        dragId = null;
        post('/order', { order: order }).then(apply);
      });
      listEl.appendChild(li);
    });
  }

  function crw() {
    if (!state) return;
    var c = state.crw;
    var color = c.status === 'running' ? 'var(--ok)' : c.status === 'error' ? 'var(--bad)' : 'var(--warn)';
    document.getElementById('crw-info').innerHTML = '<span class="dot" style="background:' + color + '"></span>' +
      '状态 <b>' + c.status + '</b> · ' + c.host + ':' + c.port + ' · renderer ' + c.rendererMode +
      ' · ' + (c.hasBinary ? '已下载二进制' : '二进制未就绪');
    document.getElementById('crw-detail').textContent = JSON.stringify(c, null, 2);
  }

  function apply(s) { state = s; render(); crw(); }
  function get(p) { return fetch('/api/dsh-web-fetch' + p, { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); }); }
  function post(p, body) { return fetch('/api/dsh-web-fetch' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); }); }

  function toggle(id, enabled) { post('/toggle', { id: id, enabled: enabled }).then(apply); }

  document.getElementById('reset').addEventListener('click', function () {
    post('/order', { order: ['direct', 'jina', 'firecrawl', 'crw', 'exa', 'browser', 'lightpanda'] }).then(apply);
  });
  document.getElementById('refresh').addEventListener('click', function () { get('/state').then(apply); });
  document.getElementById('crw-start').addEventListener('click', function () { post('/crw', { action: 'start' }).then(apply).catch(function (e) { alert(e.message); }); });
  document.getElementById('crw-stop').addEventListener('click', function () { post('/crw', { action: 'stop' }).then(apply); });
  document.getElementById('crw-restart').addEventListener('click', function () { post('/crw', { action: 'restart' }).then(apply); });
  document.getElementById('test-run').addEventListener('click', function () {
    var url = document.getElementById('test-url').value.trim();
    if (!url) return;
    var out = document.getElementById('test-out');
    out.textContent = '测试中…';
    post('/test', { url: url }).then(function (r) {
      out.textContent = (r.results || []).map(function (x) {
        return (x.ok ? '✓ ' : '✗ ') + x.id + '  ' + x.ms + 'ms  ' + (x.ok ? x.bytes + 'B' : x.error);
      }).join('\\n') || JSON.stringify(r, null, 2);
    });
  });

  get('/state').then(apply).catch(function (e) {
    listEl.innerHTML = '<li class="row">读取失败：' + e.message + '</li>';
  });
})();
</script>
</body>
</html>`
}
