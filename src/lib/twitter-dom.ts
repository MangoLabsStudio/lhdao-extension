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

  // 策略 4(详情页主推文 fallback):Twitter status detail 页**不给主推文
  // <time> 元素套自指 link**(理由:当前已经在这条推文页),策略 1 失败;
  // 主推文区域也常常没有任何 /status/<id> 链接,策略 2/3 也失败。
  // 表现:`extractTweetIdFromArticle` 对焦点推文返回 null → scan skip →
  // 用户在详情页看不到任何 chip(这正是用户实测踩的 bug)。
  //
  // 兜底:如果当前 URL 是 /<user>/status/<id> 且 article **不是**嵌套的
  // 引用推文(无 article 祖先),用 URL 里的 tweetId。回复区 article 有
  // 自己的时间戳 link,策略 1 已经命中,不会走到这里。
  if (typeof location !== 'undefined' && location.pathname) {
    const urlMatch = location.pathname.match(/^\/[^/]+\/status\/(\d+)/)
    if (urlMatch && !article.parentElement?.closest('article')) {
      return urlMatch[1]
    }
  }
  return null
}

/**
 * Twitter handle 路径正则:`/<handle>` 后面允许 query / hash / 子路径,但
 * 排除一些保留路径(home/explore/notifications/messages/search/i)。Twitter
 * 用 / + handle 作为用户主页 URL,而且头像 link 永远是 `/elonmusk` 这种纯
 * 形式(无 /status/...)。
 */
const HANDLE_PATH_REGEX =
  /^\/([A-Za-z0-9_]{1,15})(?:\/(?:photo|header_photo|with_replies|media|likes)?)?(?:[?#]|$)/

// 跳过的 Twitter 系统路径(避免把 /home 当成 username)
const RESERVED_HANDLES = new Set([
  'home',
  'explore',
  'notifications',
  'messages',
  'search',
  'i',
  'compose',
  'settings',
  'login',
  'logout',
  'signup',
])

/**
 * 从一条 <article> 提取**推文作者的 Twitter handle**(无 @,小写)。
 *
 * 策略:Twitter timeline 上每条 article 的作者信息区有
 *   `<div data-testid="User-Name">`
 * 里头第一个指向 `/handle` 形式 URL 的 <a>(不是 /status/ 链接)就是作者
 * 主页链接,handle 在 href 里。
 *
 * 嵌套引用推文有自己的 User-Name 区,我们用 closest('article') 校验归属。
 *
 * @returns lowercase handle, or null when the structure is unrecognized
 */
export function extractAuthorHandleFromArticle(
  article: Element,
): string | null {
  // 策略 1:data-testid="User-Name" 容器内的第一个 user-link
  const nameBlock = article.querySelector('[data-testid="User-Name"]')
  if (nameBlock) {
    const handle = scanUserLinkIn(nameBlock, article)
    if (handle) return handle
  }

  // 策略 2:整篇 article 内任意 user-link (兜底,某些视图 User-Name 不存在)
  const handle = scanUserLinkIn(article, article)
  return handle
}

function scanUserLinkIn(scope: Element, owningArticle: Element): string | null {
  const links = scope.querySelectorAll('a[role="link"]')
  for (const a of Array.from(links)) {
    if (a.closest('article') !== owningArticle) continue // 引用推文的 link,跳过
    const href = a.getAttribute('href') ?? ''
    const m = href.match(HANDLE_PATH_REGEX)
    if (!m) continue
    const handle = m[1].toLowerCase()
    if (RESERVED_HANDLES.has(handle)) continue
    return handle
  }
  return null
}

/**
 * 找 article 内的作者头像链接(`<a href="/handle">` 包着头像 img)。
 * 给它打 data-attribute 让 CSS 加 ring 视觉。
 *
 * Twitter timeline article DOM 结构(简化):
 *   <article>
 *     <div>
 *       <a href="/elonmusk" role="link">    ← 头像链接
 *         <div>
 *           <img src="..." />               ← 头像
 *         </div>
 *       </a>
 *       <a href="/elonmusk" role="link">Elon Musk</a>    ← 名字链接
 *       <a href="/elonmusk" role="link">@elonmusk</a>    ← handle 链接
 *     </div>
 *     ...
 *   </article>
 *
 * 头像链接的特征是**里面有 <img>**,其他几个 user-link 是纯文字。用这个区分。
 */
export function findAuthorAvatarLink(
  article: Element,
  authorHandle: string,
): HTMLAnchorElement | null {
  const targetHref = `/${authorHandle}`
  const links = article.querySelectorAll<HTMLAnchorElement>('a[role="link"]')
  for (const a of Array.from(links)) {
    if (a.closest('article') !== article) continue
    const href = a.getAttribute('href')?.toLowerCase() ?? ''
    if (href !== targetHref) continue
    // 头像链接的判定:link 内有 <img>
    if (a.querySelector('img')) return a
  }
  return null
}
