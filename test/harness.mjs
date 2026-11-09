/**
 * Offline harness: mount the plugin with a fake Cordis ctx and exercise the
 * provider + bridge routes. Keeps the real DSH app out of the loop so we can
 * iterate quickly.
 */
import http from 'node:http'
import { apply } from '../index.js'
import { ALL_BACKENDS } from '../lib/backends.js'

const logs = []
const disposers = []
const routes = []

const ctx = {
  logger: { info: (m) => logs.push(`INFO ${m}`), warn: (m) => logs.push(`WARN ${m}`), error: (m) => logs.push(`ERR ${m}`) },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
  },
  inject(names, fn) {
    // pretend every service is available, except 'settings' which is optional
    const sctx = {
      get: (n) => (n === 'webServer' ? { register: (r) => { routes.push(r); return () => {} } } : {}),
      settings: { mutate: async () => {} },
      effect: (fn2) => { const d = fn2(); if (typeof d === 'function') disposers.push(d) },
    }
    fn(sctx)
  },
  web: {
    config: { fetchProvider: { get: () => 'http' } },
    registerFetchProvider: (p) => { ctx.__provider = p; return () => {} },
  },
  get: () => undefined,
}

apply(ctx, {})

console.log('provider id:', ctx.__provider?.id)
console.log('routes:', routes.map((r) => r.path).join(', '))
console.log('--- logs ---')
console.log(logs.join('\n'))

// start a tiny server that mirrors the bridge contract
const server = http.createServer(async (req, res) => {
  const route = routes.find((r) => r.path === req.url.split('?')[0])
  if (!route) { res.writeHead(404); res.end('nf'); return }
  await route.handler(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
console.log(`\nbridge on http://127.0.0.1:${port}`)

const getJson = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json()
const postJson = async (p, body) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

const state = await getJson('/api/dsh-web-fetch/state')
console.log('\n=== /state ===')
console.log('order:', state.order.join(' → '))
console.log('backends:')
for (const b of state.backends) console.log(`  ${b.enabled ? '✓' : ' '} ${b.id.padEnd(12)} available=${b.available} ${b.reason || ''}`)
console.log('crw:', JSON.stringify(state.crw))

console.log('\n=== direct backends probe (no crw) ===')
for (const id of ['direct', 'jina']) {
  const t0 = Date.now()
  try {
    const r = await ALL_BACKENDS.find((b) => b.id === id).fetch('https://mygo.egoist.dev/docs/ui', {
      keys: {}, timeouts: { direct: 20000, jina: 25000, firecrawl: 40000, exa: 30000, crw: 60000, browser: 20000, lightpanda: 25000 },
      crw: null, browserPath: '', lightpandaPath: '', log: () => {},
    })
    console.log(`  ${id}: OK ${r.body.content.length}B ${Date.now() - t0}ms`)
  } catch (err) {
    console.log(`  ${id}: FAIL ${Date.now() - t0}ms ${err.message}`)
  }
}

console.log('\n=== provider.fetch end-to-end ===')
for (const url of ['https://mygo.egoist.dev/docs/ui', 'https://arxiv.org/abs/2308.00001']) {
  const t0 = Date.now()
  try {
    const r = await ctx.__provider.fetch({ url })
    console.log(`  OK ${r.body.content.length}B ${Date.now() - t0}ms ${url}`)
  } catch (err) {
    console.log(`  FAIL ${Date.now() - t0}ms ${url} :: ${err.message}`)
  }
}

console.log('\n=== /order ===')
const reordered = await postJson('/api/dsh-web-fetch/order', { order: ['jina', 'direct', 'crw', 'firecrawl', 'exa', 'browser', 'lightpanda'] })
console.log('new order:', reordered.order.join(' → '))

console.log('\n=== /toggle ===')
const toggled = await postJson('/api/dsh-web-fetch/toggle', { id: 'exa', enabled: false })
console.log('exa enabled:', toggled.enabled.exa)

console.log('\n=== /test (direct only) ===')
const test = await postJson('/api/dsh-web-fetch/test', { id: 'direct', url: 'https://example.com' })
console.log(JSON.stringify(test.results, null, 2).slice(0, 500))

console.log('\n=== /ui ===')
const uiRes = await fetch(`http://127.0.0.1:${port}/api/dsh-web-fetch/ui`)
const html = await uiRes.text()
console.log('status', uiRes.status, 'bytes', html.length, 'has drag:', html.includes('dragstart'))

server.close()
console.log('\n--- final logs ---')
console.log(logs.slice(-10).join('\n'))
