/**
 * Xiaohongshu (小红书) backend.
 *
 * There is no public read API. The two paths that actually work in practice are
 * (a) drive a logged-in browser, or (b) replay a logged-in session's cookies
 * against the web page and read the embedded `window.__INITIAL_STATE__` blob —
 * which is what the popular XHS-Downloader / xhs SDK projects do (with a signed
 * request they add an `x-s` header; the plain page request usually works when
 * the cookie is fresh).
 *
 * This module implements (b): cookie in, note JSON out, Markdown rendered.
 * If the cookie is missing or expired we fail loudly with instructions instead
 * of silently degrading to a login-wall page.
 */

import http from 'node:http'
import https from 'node:https'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

export function parseXhsUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return null }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase()
  if (!/(^|\.)xiaohongshu\.com$/.test(host)) return null
  const p = u.pathname
  const m = /^\/(?:explore|discovery\/item)\/([0-9a-zA-Z]+)/.exec(p)
  if (m) return { kind: 'note', noteId: m[1] }
  if (/^\/user\/profile\//.test(p)) return { kind: 'profile' }
  return { kind: 'other' }
}

function get(url, { cookie, timeoutMs = 20000, signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const mod = target.protocol === 'http:' ? http : https
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'accept-encoding': 'identity',
        referer: 'https://www.xiaohongshu.com/',
        cookie,
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        try { resolve(get(new URL(res.headers.location, target).toString(), { cookie, timeoutMs, signal, headers })) } catch (e) { reject(e) }
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    if (signal) {
      if (signal.aborted) { req.destroy(new Error('aborted')); return }
      signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    }
    req.end()
  })
}

/** Extract `window.__INITIAL_STATE__ = {...}` by brace matching (strings aware). */
export function extractInitialState(html) {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/g
  const m = marker.exec(html)
  if (!m) return null
  let i = m.index + m[0].length
  while (i < html.length && html[i] !== '{') i += 1
  if (i >= html.length) return null
  const start = i
  let depth = 0
  let inStr = false
  let quote = ''
  let esc = false
  for (; i < html.length; i += 1) {
    const ch = html[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === '\\') { esc = true; continue }
      if (ch === quote) { inStr = false; quote = '' }
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const raw = html.slice(start, i + 1)
        try { return JSON.parse(raw) } catch { return null }
      }
    }
  }
  return null
}

function pickNote(state, noteId) {
  const map = state?.note?.noteDetailMap
  if (!map) return null
  if (map[noteId]?.note) return map[noteId].note
  for (const key of Object.keys(map)) {
    const n = map[key]?.note
    if (n && (String(n.noteId) === String(noteId) || String(n.id) === String(noteId))) return n
  }
  // single-note pages sometimes only carry one entry
  const keys = Object.keys(map)
  if (keys.length === 1 && map[keys[0]]?.note) return map[keys[0]].note
  return null
}

function render(note, noteId) {
  const lines = []
  const title = note.title || note.desc?.split('\n')[0]?.slice(0, 60) || `小红书笔记 ${noteId}`
  lines.push(`# ${title}`)
  lines.push('')
  const meta = []
  if (note.user?.nickname) meta.push(`作者：${note.user.nickname}`)
  if (note.interactInfo?.likedCount) meta.push(`赞 ${note.interactInfo.likedCount}`)
  if (note.interactInfo?.collectedCount) meta.push(`收藏 ${note.interactInfo.collectedCount}`)
  if (note.interactInfo?.commentCount) meta.push(`评论 ${note.interactInfo.commentCount}`)
  if (note.time) meta.push(`时间 ${note.time}`)
  if (meta.length) { lines.push(`> ${meta.join(' · ')}`); lines.push('') }

  if (note.desc) { lines.push(String(note.desc).trim()); lines.push('') }

  const tags = (note.tagList || []).map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
  if (tags.length) { lines.push(tags.map((t) => `#${t}`).join(' ')); lines.push('') }

  const images = (note.imageList || []).map((im) => im?.urlDefault || im?.url || im?.urlPre).filter(Boolean)
  if (images.length) {
    lines.push(`图片（${images.length} 张）：`)
    images.forEach((src, i) => lines.push(`![图 ${i + 1}](${src})`))
    lines.push('')
  }

  const video = note.video?.media?.stream?.h264?.[0]?.masterUrl || note.video?.media?.stream?.h265?.[0]?.masterUrl
  if (video) { lines.push(`视频：[直链](${video})`); lines.push('') }

  const comments = note.comments?.list || []
  if (comments.length) {
    lines.push('## 热门评论')
    lines.push('')
    comments.slice(0, 10).forEach((c) => {
      const who = c?.userInfo?.nickname || '匿名'
      const txt = c?.content || ''
      if (txt) lines.push(`- **${who}**：${txt}`)
    })
    lines.push('')
  }
  return lines.join('\n').trim()
}

/**
 * @returns {Promise<{markdown: string, noteId: string}>}
 */
export async function fetchXhs(rawUrl, { cookie, timeoutMs = 20000, signal } = {}) {
  const parsed = parseXhsUrl(rawUrl)
  if (!parsed) throw new Error('xiaohongshu: not a xiaohongshu.com URL')
  if (parsed.kind !== 'note') {
    throw new Error('xiaohongshu: 只支持笔记详情页（/explore/<id> 或 /discovery/item/<id>），不支持个人主页/搜索页。')
  }
  if (!cookie) {
    throw new Error(
      'xiaohongshu: 未配置 Cookie。小红书没有公开读接口，必须在「接口密钥 → 小红书 Cookie」里填入' +
      '登录 xiaohongshu.com 后的 document.cookie（至少含 a1 与 web_session），或把该站点规则改到 cdp 用登录态浏览器。',
    )
  }

  const url = `https://www.xiaohongshu.com/explore/${parsed.noteId}`
  const res = await get(url, { cookie, timeoutMs, signal })
  if (res.statusCode >= 400) throw new Error(`xiaohongshu: HTTP ${res.statusCode}`)

  const html = res.text
  if (/登录|扫码|请先登录/.test(html.slice(0, 2000)) && !/noteDetailMap/.test(html)) {
    throw new Error('xiaohongshu: 返回的是登录页，Cookie 已失效或缺少 web_session。')
  }
  const state = extractInitialState(html)
  if (!state) throw new Error('xiaohongshu: 页面里没有 __INITIAL_STATE__（可能是风控页或结构变更）。')
  const note = pickNote(state, parsed.noteId)
  if (!note) throw new Error('xiaohongshu: __INITIAL_STATE__ 里找不到该笔记（Cookie 失效或被限流）。')
  const markdown = render(note, parsed.noteId)
  if (markdown.length < 40) throw new Error('xiaohongshu: 笔记内容为空。')
  return { markdown, noteId: parsed.noteId }
}
