/**
 * Backend comparison benchmark.
 *
 *   node bench/compare.mjs [--urls url1,url2] [--repeat 1]
 *
 * Runs each fetch backend in isolation against the same URL set and prints
 * latency / payload size / failure reason. Nothing here goes through the
 * fallback chain, so the numbers are per-backend, not per-request.
 */
import { BACKEND_BY_ID } from '../lib/backends.js'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

function creds() {
  const out = {}
  for (const name of ['.credentials.yaml', 'credentials.yaml']) {
    const p = join(HOME, name)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      let v = m[2]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (v && v !== 'null') out[m[1]] = v
    }
  }
  return out
}

const C = creds()

const ctx = {
  keys: { firecrawl: C.FIRECRAWL_API_KEY || '', exa: C.EXA_API_KEY || '', jina: C.JINA_API_KEY || '' },
  timeouts: { direct: 20000, jina: 25000, firecrawl: 40000, exa: 30000, crw: 60000, browser: 30000, lightpanda: 25000 },
  browserPath: process.env.BENCH_BROWSER_PATH || '',
  browserStealth: true,
  crw: {
    baseURL: process.env.BENCH_CRW_URL || 'http://127.0.0.1:38210',
    info: () => ({ status: 'running' }),
    hasBinary: () => true,
    start: async () => {},
  },
  lightpandaPath: '',
  log: () => {},
}

const DEFAULT_URLS = [
  'https://example.com',
  'https://mygo.egoist.dev/docs/ui',
  'https://arxiv.org/abs/2308.00001',
  'https://en.wikipedia.org/wiki/Rust_(programming_language)',
  'https://github.com/zed-industries/zed',
  'https://stackoverflow.com/questions/11227809',
  'https://www.npmjs.com/package/react',
  'https://juejin.cn/post/7705441553616388146',
]

const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const urls = arg('--urls', '').split(',').filter(Boolean).length ? arg('--urls').split(',') : DEFAULT_URLS
const repeat = Number(arg('--repeat', '1')) || 1
const only = arg('--only', '').split(',').filter(Boolean)

const ids = only.length ? only : ['direct', 'jina', 'firecrawl', 'crw', 'browser']
const rows = []

for (const url of urls) {
  for (const id of ids) {
    const backend = BACKEND_BY_ID[id]
    if (!backend) { rows.push({ url, id, ok: false, ms: 0, bytes: 0, error: 'unknown backend' }); continue }
    let ok = false, ms = 0, bytes = 0, error = ''
    for (let r = 0; r < repeat; r++) {
      const t = Date.now()
      try {
        const res = await backend.fetch(url, ctx, undefined)
        ok = true
        ms = Date.now() - t
        bytes = res.body.content.length
      } catch (err) {
        ok = false
        ms = Date.now() - t
        bytes = 0
        error = err.message.slice(0, 120)
      }
    }
    rows.push({ url, id, ok, ms, bytes, error })
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${id.padEnd(10)} ${String(ms).padStart(6)}ms ${String(bytes).padStart(8)}B  ${url}${error ? '  :: ' + error : ''}`)
  }
}

console.log('\n--- markdown table ---')
console.log('| URL | backend | ok | ms | bytes |')
console.log('| --- | --- | --- | --- | --- |')
for (const r of rows) console.log(`| ${r.url} | ${r.id} | ${r.ok ? 'yes' : 'no'} | ${r.ms} | ${r.bytes} |`)
