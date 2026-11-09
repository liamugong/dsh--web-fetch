/**
 * CRW (fastCRW) supervisor.
 *
 * Responsibilities:
 *  - locate (and, if needed, download) the `crw-server` single binary
 *  - generate a local config.toml that binds to loopback with **no auth**
 *    (the mode the dsh--web-fetch plugin is specified to use)
 *  - spawn / health-check / stop the process for the lifetime of the plugin
 *
 * The supervisor is deliberately dependency free: node:fs / node:https /
 * node:child_process only, so the plugin stays a plain-JS bundle with no build
 * step.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import http from 'node:http'

const CRW_REPO = 'fastcrw/crw'
const RELEASE_BASE = `https://github.com/${CRW_REPO}/releases/download`

/** @returns {'darwin'|'linux'|'win32'} */
function platformTag() {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'win32') return 'win32'
  throw new Error(`unsupported platform: ${process.platform}`)
}

/** @returns {'arm64'|'x64'} */
function archTag() {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x64'
  throw new Error(`unsupported arch: ${process.arch}`)
}

/**
 * crw-server asset naming, e.g. crw-server-darwin-arm64.tar.gz.
 * Windows ships .zip; we only auto-download the tar.gz platforms and let
 * Windows users point `binaryPath` at a manual install.
 */
export function crwAssetName(version = 'v0.43.1') {
  const p = platformTag()
  const a = archTag()
  if (p === 'win32') return `crw-server-win32-${a}.zip`
  return `crw-server-${p}-${a}.tar.gz`
}

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'dsh--web-fetch', accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        resolve(fetchJson(res.headers.location, timeoutMs))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`GitHub API ${res.statusCode} for ${url}`))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
  })
}

function download(url, dest, { timeoutMs = 180000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(dest)
    const req = https.get(url, { headers: { 'user-agent': 'dsh--web-fetch' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        out.close()
        resolve(download(res.headers.location, dest, { timeoutMs, signal }))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        out.close()
        reject(new Error(`download ${res.statusCode} for ${url}`))
        return
      }
      res.pipe(out)
      out.on('finish', () => out.close(() => resolve(dest)))
      res.on('error', reject)
    })
    req.on('error', (err) => { out.close(); reject(err) })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('download timeout')))
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
  })
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`)))
  })
}

export class CrwSupervisor {
  /**
   * @param {object} options
   * @param {string} options.stateDir  directory holding binary + config + logs
   * @param {string} [options.binaryPath] explicit binary path (overrides download)
   * @param {number} [options.port]
   * @param {string} [options.host]
   * @param {string} [options.version]
   * @param {boolean} [options.autoDownload]
   * @param {string} [options.rendererMode]
   * @param {string} [options.chromeWsUrl]
   * @param {(msg: string) => void} [options.log]
   */
  constructor(options) {
    this.stateDir = options.stateDir
    this.binaryPath = options.binaryPath || join(this.stateDir, 'bin', 'crw-server')
    this.port = options.port ?? 38210
    this.host = options.host || '127.0.0.1'
    this.version = options.version || 'v0.43.1'
    this.autoDownload = options.autoDownload !== false
    this.rendererMode = options.rendererMode || 'auto'
    this.chromeWsUrl = options.chromeWsUrl || ''
    this.log = options.log || (() => {})
    this.child = null
    this.status = 'stopped'
    this.lastError = null
    this.startedAt = 0
    this._starting = null
  }

  get baseURL() {
    return `http://${this.host}:${this.port}`
  }

  /** Whether a usable binary is already on disk. */
  hasBinary() {
    try { return statSync(this.binaryPath).isFile() } catch { return false }
  }

  async ensureBinary(signal) {
    if (this.hasBinary()) return this.binaryPath
    if (!this.autoDownload) throw new Error(`crw-server not found at ${this.binaryPath} (autoDownload disabled)`)
    if (platformTag() === 'win32') throw new Error('auto-download is not supported on Windows; set crw.binaryPath manually')

    mkdirSync(join(this.stateDir, 'bin'), { recursive: true })
    const asset = crwAssetName(this.version)
    const url = `${RELEASE_BASE}/${this.version}/${asset}`
    const tarball = join(this.stateDir, 'bin', asset)
    this.log(`downloading ${url}`)
    await download(url, tarball, { signal })
    await run('tar', ['-xzf', tarball, '-C', join(this.stateDir, 'bin')])
    // the archive contains a single `crw-server` entry
    const extracted = join(this.stateDir, 'bin', 'crw-server')
    if (!existsSync(extracted)) {
      throw new Error(`archive did not contain crw-server (looked in ${join(this.stateDir, 'bin')})`)
    }
    chmodSync(extracted, 0o755)
    if (extracted !== this.binaryPath) {
      // honour a custom binaryPath by copying
      writeFileSync(this.binaryPath, readFileSync(extracted))
      chmodSync(this.binaryPath, 0o755)
    }
    this.log(`crw-server ready at ${this.binaryPath}`)
    return this.binaryPath
  }

  /** Effective renderer mode: `auto` without a CDP endpoint must degrade to
   *  `none`. CRW otherwise logs `JS renderers in fallback order: ["chrome"]`
   *  even with an empty ws_url and then answers every scrape with an empty
   *  reply. */
  effectiveRendererMode() {
    const mode = this.rendererMode || 'auto'
    if (!this.chromeWsUrl && (mode === 'auto' || mode === 'chrome' || mode === 'playwright')) return 'none'
    if (mode === 'auto') return 'chrome'
    return mode
  }

  writeConfig() {
    mkdirSync(join(this.stateDir, 'run'), { recursive: true })
    const configPath = join(this.stateDir, 'run', 'config.toml')
    const mode = this.effectiveRendererMode()
    const lines = [
      '# generated by dsh--web-fetch — local, unauthenticated CRW instance',
      '[server]',
      `host = "${this.host}"`,
      `port = ${this.port}`,
      '',
      '[renderer]',
      `mode = "${mode}"`,
      'page_timeout_ms = 45000',
      'pool_size = 2',
      '',
    ]
    if (this.chromeWsUrl) {
      lines.push('[renderer.chrome]', `ws_url = "${this.chromeWsUrl}"`, '')
    }
    lines.push('[crawler]', 'respect_robots_txt = true', '')
    writeFileSync(configPath, lines.join('\n'))
    return configPath
  }

  health(timeoutMs = 2000) {
    return new Promise((resolve) => {
      const req = http.get(`${this.baseURL}/health`, { timeout: timeoutMs }, (res) => {
        let body = ''
        res.on('data', (d) => { body += d })
        res.on('end', () => {
          try { resolve(res.statusCode === 200 ? JSON.parse(body) : null) } catch { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  async start(signal) {
    if (this.status === 'running') return this.info()
    if (this._starting) return this._starting
    this._starting = (async () => {
      this.status = 'starting'
      this.lastError = null
      try {
        await this.ensureBinary(signal)
        const configPath = this.writeConfig()
        const env = {
          ...process.env,
          CRW_CONFIG: configPath,
          CRW_USER_CONFIG_DIR: join(this.stateDir, 'run'),
          // On macOS/Linux the machine may use a TUN fake-IP resolver
          // (198.18.0.0/15); CRW treats that range as private and refuses the
          // request. This flag is the documented escape hatch.
          CRW_ALLOW_LOOPBACK_FOR_TESTS: '1',
        }
        if (this.chromeWsUrl) env.CRW_RENDERER__CHROME__WS_URL = this.chromeWsUrl
        const logFd = join(this.stateDir, 'run', 'crw.log')
        const child = spawn(this.binaryPath, [], {
          cwd: join(this.stateDir, 'run'),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        })
        this.child = child
        let logBuf = ''
        const capture = (d) => {
          logBuf += d.toString()
          if (logBuf.length > 64000) logBuf = logBuf.slice(-32000)
        }
        child.stdout?.on('data', capture)
        child.stderr?.on('data', capture)
        child.on('exit', (code) => {
          if (this.child === child) {
            this.status = 'stopped'
            this.child = null
            this.lastError = code === 0 ? null : `crw-server exited with code ${code}`
          }
        })
        // wait for /health
        const deadline = Date.now() + 20000
        while (Date.now() < deadline) {
          const h = await this.health(1000)
          if (h) {
            this.status = 'running'
            this.startedAt = Date.now()
            this.log(`crw-server listening on ${this.baseURL} (version ${h.version})`)
            return this.info()
          }
          await new Promise((r) => setTimeout(r, 250))
        }
        try { writeFileSync(logFd, logBuf) } catch {}
        throw new Error(`crw-server did not become healthy on ${this.baseURL}; log tail: ${logBuf.slice(-600)}`)
      } catch (err) {
        this.status = 'error'
        this.lastError = err.message
        this.log(`crw start failed: ${err.message}`)
        try { this.child?.kill('SIGTERM') } catch {}
        this.child = null
        throw err
      } finally {
        this._starting = null
      }
    })()
    return this._starting
  }

  async stop() {
    const child = this.child
    this.child = null
    this.status = 'stopped'
    if (!child) return
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      child.once('exit', finish)
      setTimeout(() => { try { child.kill('SIGKILL') } catch {}; finish() }, 3000)
    })
  }

  async restart(signal) {
    await this.stop()
    return this.start(signal)
  }

  info() {
    return {
      status: this.status,
      host: this.host,
      port: this.port,
      baseURL: this.baseURL,
      binaryPath: this.binaryPath,
      hasBinary: this.hasBinary(),
      version: this.version,
      rendererMode: this.rendererMode,
      chromeWsUrl: this.chromeWsUrl,
      startedAt: this.startedAt,
      lastError: this.status === 'error' ? this.lastError : null,
    }
  }
}
