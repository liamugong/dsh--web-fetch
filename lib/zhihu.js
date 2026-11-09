/**
 * Zhihu Open Platform (知乎开放平台) backend.
 *
 * The public MCP endpoint only exposes search-style tools, so it cannot resolve
 * a URL to a page. The REST API does have a per-question endpoint:
 *
 *   GET https://developer.zhihu.com/api/v1/content/question_answers
 *       ?QuestionUrl=<full question url>&Offset=0&Limit=50
 *       Authorization: Bearer <access secret>
 *       X-Request-Timestamp: <seconds since epoch>
 *
 * It returns answer *summaries* (the docs are explicit that they are extracted
 * snippets, not full text). That is still far better than the 403 login wall
 * the public site serves to anonymous clients, and it costs no browser.
 */

const API_BASE = 'https://developer.zhihu.com'

/** Parse the handful of Zhihu URL shapes we care about. */
export function parseZhihuUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return null }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase()
  if (!/(^|\.)zhihu\.com$/.test(host)) return null
  const p = u.pathname

  const mAnswer = /^\/question\/(\d+)\/answer\/(\d+)/.exec(p)
  if (mAnswer) {
    return {
      kind: 'answer',
      questionId: mAnswer[1],
      answerId: mAnswer[2],
      questionUrl: `https://www.zhihu.com/question/${mAnswer[1]}`,
    }
  }
  const mQuestion = /^\/question\/(\d+)/.exec(p)
  if (mQuestion) {
    return {
      kind: 'question',
      questionId: mQuestion[1],
      questionUrl: `https://www.zhihu.com/question/${mQuestion[1]}`,
    }
  }
  const mArticle = /^\/p\/(\d+)/.exec(p)
  if (mArticle) return { kind: 'article', articleId: mArticle[1] }
  const mPin = /^\/pin\/(\d+)/.exec(p)
  if (mPin) return { kind: 'pin', pinId: mPin[1] }
  return { kind: 'other' }
}

function describeError(code, message) {
  const hints = {
    10001: '问题 URL 或分页参数错误，或者问题不存在',
    20001: '鉴权或授权失败（Access Secret 无效/未授权）',
    30001: '调用频率、并发或当日额度超限',
    30002: '累计成功次数额度耗尽',
    30003: '请求被风控拒绝',
    90001: '服务内部错误',
  }
  const hint = hints[code] ? `（${hints[code]}）` : ''
  return `zhihu: [${code}] ${message || 'unknown error'}${hint}`
}

async function callQuestionAnswers(questionUrl, { key, offset = 0, limit = 20, timeoutMs = 20000, signal }) {
  const url = `${API_BASE}/api/v1/content/question_answers?QuestionUrl=${encodeURIComponent(questionUrl)}&Offset=${offset}&Limit=${limit}`
  const headers = {
    authorization: `Bearer ${key}`,
    'x-request-timestamp': String(Math.floor(Date.now() / 1000)),
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'dsh-web-fetch/0.4 (+https://github.com/liamugong/dsh--web-fetch)',
  }
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  const composed = signal && timeout ? AbortSignal.any([signal, timeout]) : signal || timeout
  const res = await fetch(url, { headers, signal: composed })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`zhihu: non-JSON response (HTTP ${res.status})`) }
  if (json.Code !== 0) throw new Error(describeError(json.Code, json.Message))
  return json.Data || {}
}

/** Render the API payload as Markdown that a model can actually read. */
function render(questionId, questionUrl, items, extra = {}) {
  const lines = []
  lines.push(`# 知乎问题 ${questionId}`)
  lines.push('')
  lines.push(`> 来源：知乎开放平台「问题回答 API」 · ${questionUrl}`)
  lines.push('> 说明：接口返回的是每条回答的**摘要/截取文本**，不是回答全文；按接口文档，摘要不代表全文。')
  if (extra.matched) lines.push(`> 已按 URL 中的回答 id \`${extra.matched}\` 精确匹配。`)
  lines.push('')
  if (!items.length) {
    lines.push('（接口没有返回可用的回答摘要：可能该问题暂无回答，或返回项都被过滤。）')
    return lines.join('\n')
  }
  items.forEach((it, i) => {
    lines.push(`## ${i + 1}. 回答 ${it.ContentToken || ''}`)
    lines.push('')
    lines.push(String(it.Summary || '').trim())
    lines.push('')
    if (it.Url) lines.push(`[查看原回答](${it.Url})`)
    lines.push('')
  })
  return lines.join('\n').trim()
}

/**
 * @returns {Promise<{markdown: string, count: number}>}
 */
export async function fetchZhihu(rawUrl, { key, timeoutMs = 20000, limit = 20, signal } = {}) {
  if (!key) throw new Error('zhihu: 缺少 ZHIHU_API_KEY（知乎开放平台 Access Secret）')
  const parsed = parseZhihuUrl(rawUrl)
  if (!parsed) throw new Error('zhihu: not a zhihu.com URL')

  if (parsed.kind === 'article') {
    throw new Error(
      'zhihu: 专栏文章（zhuanlan.zhihu.com/p/*）没有可用的开放平台全文接口' +
      '（/api/v1/content/detail 对本账号返回 permission denied）；请把 zhuanlan.zhihu.com 的站点规则指向 jina 或 browser。',
    )
  }
  if (parsed.kind === 'pin') {
    throw new Error('zhihu: 想法（pin）没有开放平台接口；请把该域名的站点规则指向 jina 或 browser。')
  }
  if (parsed.kind !== 'question' && parsed.kind !== 'answer') {
    throw new Error('zhihu: 这个知乎 URL 不是问题/回答页，无法用 question_answers 接口取内容。')
  }

  const pageSize = Math.max(1, Math.min(50, limit))
  const data = await callQuestionAnswers(parsed.questionUrl, { key, limit: pageSize, timeoutMs, signal })
  let items = Array.isArray(data.Items) ? data.Items : []

  let matched = ''
  if (parsed.kind === 'answer') {
    const hit = items.find((it) => String(it.ContentToken) === String(parsed.answerId))
    if (hit) {
      items = [hit, ...items.filter((it) => it !== hit)]
      matched = parsed.answerId
    }
  }

  const paging = data.Paging || {}
  const markdown = render(parsed.questionId, parsed.questionUrl, items, { matched })
  if (!items.length && paging && paging.Totals === 0) {
    // still return the explanation page rather than throwing: an empty question
    // is a legitimate answer.
  }
  return { markdown, count: items.length, paging }
}
