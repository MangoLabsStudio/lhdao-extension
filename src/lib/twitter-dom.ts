/**
 * Twitter / X DOM 解析工具。content script 用来从 timeline 抽取 tweet id。
 *
 * 设计原则:
 *   - 纯函数,不依赖 chrome.* API,可在 vitest 里跑(happy-dom 环境)
 *   - 只识别 x.com / twitter.com 两个 host,防止 spoofed link 偷换路径
 *   - 失败一律返回 null,不抛异常 — content script 高频调用,异常太贵
 */

const TWEET_URL_REGEX = /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/

/**
 * 从一个绝对 URL 里抽 tweet id。识别 x.com / twitter.com,允许 /photo/N
 * 等子路径与 query string,但不接受其他 host。
 *
 * @returns tweet id 字符串,或 null(非推文 URL / 非白名单 host / 解析失败)
 */
export function extractTweetIdFromUrl(url: string): string | null {
  if (!url) return null
  const m = url.match(TWEET_URL_REGEX)
  return m ? m[1] : null
}

const STATUS_PATH_REGEX = /\/status\/(\d+)/

/**
 * 从一个 <article> 节点里找第一个含 /status/<id>/ 的 <a>,返回 tweet id。
 * Twitter timeline 的 <article> 通常包含多个 link;取第一个匹配的即可。
 *
 * @returns tweet id 字符串,或 null(article 内无 /status/ 链接)
 */
export function extractTweetIdFromArticle(article: Element): string | null {
  const links = article.querySelectorAll('a[href*="/status/"]')
  for (const a of Array.from(links)) {
    const href = a.getAttribute('href') ?? ''
    const m = href.match(STATUS_PATH_REGEX)
    if (m) return m[1]
  }
  return null
}
