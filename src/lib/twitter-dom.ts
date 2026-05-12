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
 * 从一个 <article> 节点里抽出 tweet id,**专门处理引用推文嵌套场景**。
 *
 * 策略(按可靠度递减):
 *   1. <time> 元素的最近 a[href*="/status/"]:Twitter 把时间戳套在通向
 *      该推文自己 /status/<id> 的链接里,**这是该 article 自己的 id**,
 *      不会跑偏到引用的推文。
 *   2. 直接子级 a[href*="/status/"](排除嵌套 article 内的链接):
 *      用 closest('article') 反查归属。
 *   3. 兜底:第一个 a[href*="/status/"](维持向后兼容)。
 *
 * @returns tweet id 字符串,或 null(article 内无 /status/ 链接)
 */
export function extractTweetIdFromArticle(article: Element): string | null {
  // 策略 1:time 元素锚点(最可靠)
  const timeEl = article.querySelector('time')
  if (timeEl) {
    const timeLink = timeEl.closest('a[href*="/status/"]')
    if (timeLink) {
      const href = timeLink.getAttribute('href') ?? ''
      const m = href.match(STATUS_PATH_REGEX)
      if (m) return m[1]
    }
  }

  // 策略 2:直接归属本 article 的 status link(排除嵌套 quote tweet)
  const links = article.querySelectorAll('a[href*="/status/"]')
  for (const a of Array.from(links)) {
    // 如果这个 a 的最近 article 不是我们当前 article,说明它属于嵌套的
    // 引用推文(article > ... > article > a),跳过。
    if (a.closest('article') !== article) continue
    const href = a.getAttribute('href') ?? ''
    const m = href.match(STATUS_PATH_REGEX)
    if (m) return m[1]
  }

  // 策略 3:兜底,任意 /status/ 链接(尽量挽救能识别的)
  for (const a of Array.from(links)) {
    const href = a.getAttribute('href') ?? ''
    const m = href.match(STATUS_PATH_REGEX)
    if (m) return m[1]
  }
  return null
}
