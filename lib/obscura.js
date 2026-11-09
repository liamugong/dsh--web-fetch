/**
 * Obscura manager.
 *
 * Obscura (https://github.com/h4ckf0r0day/obscura) is a Rust headless browser
 * engine with its own renderer (no Chromium). It exposes a `fetch` CLI that can
 * dump rendered HTML/Markdown-ish text without any browser process tree.
 *
 * This module only does three things:
 *  - resolve which obscura binary to use (explicit path > managed install > PATH)
 *  - download + unpack a release build on demand
 *  - report a small status object for the settings card
 *
 * Dependency free: node:fs / node:https / node:child_process only.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'

const OBSCURA_REPO = 'h4ckf0r0day/obscura'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function dataDir() {
  return join(dshHome(), 'dsh-web-fetch')
}

export function binDir() {
  return join(dataDir(), 'bin')
}

export function managedBinaryPath() {
  return join(binDir(), process.platform === 'win32' ? 'obscura.exe' : 'obscura')
}

/** Assets are named obscura-<arch>-<os>[-no-render][-stealth].tar.gz */
export function obscuraAssetName(stealth = true) {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'windows' : ''
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : ''
  if (!os || !arch) throw new Error(`obscura: unsupported platform ${process.platform}/${process.arch}`)
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz'
  return `obscura-${arch}-${os}${stealth ? '-stealth' : ''}.${ext}`
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`))))
  })
}

function download(url, dest, { timeoutMs = 600000, signal } = {}) {
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

function findOnPath() {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const d of dirs) {
    const p = join(d, process.platform === 'win32' ? 'obscura.exe' : 'obscura')
    try { if (existsSync(p)) return p } catch {}
  }
  return ''
}

/**
 * Where is obscura? explicit > managed download > PATH.
 * Returns '' when nothing is found.
 */
export function findObscura(explicit) {
  if (explicit && existsSync(explicit)) return explicit
  const managed = managedBinaryPath()
  if (existsSync(managed)) return managed
  return findOnPath()
}

export function isObscura(binaryPath) {
  if (!binaryPath) return false
  return /obscura/i.test(binaryPath)
}

export function obscuraVersion(binary) {
  if (!binary) return ''
  try {
    const out = spawnSyncQuick(binary, ['--version'])
    const m = /(\d+\.\d+\.\d+)/.exec(out)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

function spawnSyncQuick(cmd, args) {
  // Small blocking helper; only used for a version banner on a local binary.
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 })
    return `${r.stdout || ''}${r.stderr || ''}`
  } catch {
    return ''
  }
}

export class ObscuraManager {
  constructor({ state, log = () => {} } = {}) {
    this.state = state
    this.log = log
    this.downloading = false
    this.lastError = ''
  }

  binaryPath() {
    return findObscura(this.state?.browserPath)
  }

  hasBinary() {
    return Boolean(this.binaryPath())
  }

  info() {
    const bin = this.binaryPath()
    return {
      status: bin ? 'ready' : 'missing',
      binaryPath: bin,
      managedPath: managedBinaryPath(),
      version: bin ? obscuraVersion(bin) : '',
      downloading: this.downloading,
      lastError: this.lastError || undefined,
    }
  }

  async ensureBinary({ stealth = true, force = false } = {}) {
    const existing = findObscura(this.state?.browserPath)
    if (existing && !force) return existing
    if (this.downloading) throw new Error('obscura: download already in progress')
    this.downloading = true
    this.lastError = ''
    try {
      mkdirSync(binDir(), { recursive: true })
      const version = this.state?.obscura?.version || 'v0.2.6'
      const asset = obscuraAssetName(stealth)
      const url = `https://github.com/${OBSCURA_REPO}/releases/download/${version}/${asset}`
      const tarball = join(binDir(), asset)
      this.log(`[dsh-web-fetch] downloading ${url}`)
      await download(url, tarball)
      if (asset.endsWith('.zip')) {
        await run('unzip', ['-o', '-q', tarball, '-d', binDir()])
      } else {
        await run('tar', ['-xzf', tarball, '-C', binDir()])
      }
      // The archive may contain the binary at the root or inside a folder.
      let extracted = join(binDir(), process.platform === 'win32' ? 'obscura.exe' : 'obscura')
      if (!existsSync(extracted)) {
        const found = walk(binDir()).find((p) => /(^|\/)obscura(\.exe)?$/.test(p))
        if (!found) throw new Error('obscura: binary not found in archive')
        extracted = found
      }
      if (extracted !== managedBinaryPath()) {
        writeFileSync(managedBinaryPath(), readFileSync(extracted))
      }
      chmodSync(managedBinaryPath(), 0o755)
      try { rmSync(tarball, { force: true }) } catch {}
      this.log(`[dsh-web-fetch] obscura installed at ${managedBinaryPath()}`)
      return managedBinaryPath()
    } catch (err) {
      this.lastError = err.message
      throw err
    } finally {
      this.downloading = false
    }
  }
}

function walk(dir, depth = 0) {
  if (depth > 3) return []
  const out = []
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, depth + 1))
    else out.push(p)
  }
  return out
}
