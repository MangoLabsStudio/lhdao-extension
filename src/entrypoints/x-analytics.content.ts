import { sendMessage } from '@/lib/messaging'
import {
  rollingNinetyDayPeriod,
  waitForThreeMonthCapture,
} from '@/lib/x-analytics-capture'
import { createAnalyticsNetworkReader } from '@/lib/x-analytics-network'

const HOST_ID = 'lhdao-x-analytics-capture'
const metricLabels: Record<string, string> = {
  twitterUsername: 'X 账号',
  verifiedFollowers: '认证关注者',
  followers: '关注者总数',
  impressions: '曝光量',
  engagementRate: '互动率',
  engagements: '互动量',
  profileVisits: '主页访问量',
  replies: '回复',
  likes: '点赞',
  reposts: '转发',
  bookmarks: '书签',
  shares: '分享',
}

export default defineContentScript({
  matches: [
    'https://x.com/i/account_analytics*',
    'https://twitter.com/i/account_analytics*',
  ],
  runAt: 'document_start',
  async main(ctx) {
    const network = createAnalyticsNetworkReader(window)
    ctx.onInvalidated?.(() => network.dispose())
    if (!document.documentElement)
      await new Promise<void>((resolve) =>
        document.addEventListener('DOMContentLoaded', () => resolve(), {
          once: true,
        }),
      )
    return mountCaptureDialog(network.get)
  },
})

async function mountCaptureDialog(
  network: ReturnType<typeof createAnalyticsNetworkReader>['get'],
): Promise<void> {
  if (document.getElementById(HOST_ID)) return
  const host = document.createElement('div')
  host.id = HOST_ID
  const shadow = host.attachShadow({ mode: 'closed' })
  const logoUrl = chrome.runtime.getURL('icon/128.png')
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      dialog, button { font: 14px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; }
      dialog {
        position: fixed; inset: 24px 24px auto auto; margin: 0;
        box-sizing: border-box; width: min(440px, calc(100vw - 32px));
        height: min(520px, calc(100dvh - 48px)); overflow: auto; padding: 28px;
        border: 1px solid #d7e5e3; border-radius: 20px;
        background: #fff; color: #0f172a;
        box-shadow: 0 24px 80px #0f172a33;
      }
      dialog[open] { display: flex; flex-direction: column; }
      dialog > * { flex-shrink: 0; }
      dialog::backdrop { background: #0f172a80; }
      header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
      .brand { display: flex; align-items: center; gap: 9px; color: #0f766e; font-size: 12px; font-weight: 700; letter-spacing: .08em; }
      .brand img { width: 32px; height: 32px; flex-shrink: 0; }
      .brand-divider { width: 1px; height: 20px; background: #cbd5e1; margin: 0 3px; }
      .x-logo { display: grid; place-items: center; width: 32px; height: 32px;
        border-radius: 8px; background: #0f172a; color: #fff; flex-shrink: 0; }
      .x-logo svg { display: block; width: 18px; height: 18px; }
      [data-launch] img { width: 22px; height: 22px; }
      h2 { margin: 8px 0 12px; font-size: 22px; line-height: 1.4; }
      p { margin: 0 0 20px; color: #475569; }
      .period { display: flex; justify-content: space-between; padding: 14px 16px;
        margin-bottom: 20px; border-radius: 12px; background: #f0fdfa; color: #115e59; }
      .privacy { margin-bottom: 20px; padding: 16px; border: 1px solid #e2e8f0;
        border-radius: 12px; background: #f8fafc; }
      .privacy h3 { display: flex; align-items: center; gap: 8px; margin: 0;
        font-size: 14px; line-height: 1.5; }
      .privacy svg { width: 18px; height: 18px; color: #0f766e; flex-shrink: 0; }
      .privacy p { margin: 8px 0 0; font-size: 13px; line-height: 1.6; }
      button { border: 0; border-radius: 999px; padding: 11px 16px;
        background: #0f766e; color: white; cursor: pointer; font-weight: 700; }
      button:focus-visible { outline: 3px solid #5eead4; outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: .65; }
      [data-capture] { width: 100%; margin-top: auto; }
      [data-close] { flex-shrink: 0; width: 36px; height: 36px; padding: 0;
        background: #f1f5f9; color: #475569; font-size: 24px; line-height: 1; }
      [data-launch] { display: flex; align-items: center; gap: 8px; position: fixed; right: 24px; top: 24px; z-index: 2147483647;
        box-shadow: 0 4px 20px #0f172a26; }
      [hidden] { display: none !important; }
      [role="status"] { margin-top: 12px; color: #0f766e; overflow-wrap: anywhere; }
      [role="status"]:empty { display: none; }
      [data-error="true"] { color: #b42318; }
      @media (max-width: 480px) {
        dialog { top: 16px; right: 16px; height: min(520px, calc(100dvh - 32px)); }
        [data-launch] { top: 16px; right: 16px; }
      }
      @media (prefers-color-scheme: dark) {
        dialog { background: #0f172a; color: #f8fafc; border-color: #334155; }
        p { color: #cbd5e1; }
        .brand, [role="status"] { color: #5eead4; }
        .period { background: #134e4a; color: #ccfbf1; }
        .privacy { background: #1e293b; border-color: #334155; }
        .privacy svg { color: #5eead4; }
        [data-close] { background: #1e293b; color: #cbd5e1; }
        [data-error="true"] { color: #fda29b; }
      }
    </style>
    <button type="button" data-launch hidden><img src="${logoUrl}" alt="" width="22" height="22">采集 X 数据</button>
    <dialog aria-labelledby="capture-title" aria-describedby="capture-description">
      <header>
        <div><div class="brand">
          <img src="${logoUrl}" alt="" width="32" height="32"><span>LIGHTHOUSE</span>
          <span class="brand-divider" aria-hidden="true"></span>
          <span class="x-logo"><svg viewBox="0 0 13 12" role="img" aria-label="X（Twitter）" xmlns="http://www.w3.org/2000/svg">
            <path d="M10.2383 0H12.2317L7.87665 5.08308L13 12H8.98846L5.84648 7.80492L2.25133 12H0.25671L4.91485 6.56308L0 0H4.11338L6.95346 3.83446L10.2383 0ZM9.53864 10.7815H10.6432L3.51319 1.15446H2.32786L9.53864 10.7815Z" fill="currentColor" />
          </svg></span>
        </div><h2 id="capture-title">采集 X 账号数据</h2></div>
        <button type="button" data-close aria-label="关闭弹窗">×</button>
      </header>
      <p id="capture-description">读取近三个月的账号汇总，保存到你的 KOL 资料，用于严选申请。</p>
      <div class="period"><span>采集范围</span><strong>近三个月 · 3M</strong></div>
      <section class="privacy" aria-labelledby="privacy-title">
        <h3 id="privacy-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" />
          </svg>
          数据与隐私保护
        </h3>
        <p>本次仅采集申请所需的 X 账号标识及近三个月的账号汇总数据，不读取私信、密码或其他无关信息。</p>
        <p>采集数据通过加密连接传输，并受到访问权限控制。</p>
      </section>
      <button type="button" data-capture autofocus>采集并保存</button>
      <div role="status" aria-live="polite"></div>
    </dialog>
  `
  document.documentElement.appendChild(host)
  const dialog = shadow.querySelector('dialog')!
  const launcher = shadow.querySelector<HTMLButtonElement>('[data-launch]')!
  const button = shadow.querySelector<HTMLButtonElement>('[data-capture]')!
  const status = shadow.querySelector<HTMLElement>('[role="status"]')!
  const open = () => {
    launcher.hidden = true
    dialog.showModal()
  }
  launcher.addEventListener('click', open)
  shadow
    .querySelector('[data-close]')!
    .addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    launcher.hidden = false
    launcher.focus()
  })
  let expectedUsername: string | undefined
  button.addEventListener('click', () => {
    void saveCapture(button, status, expectedUsername, network)
  })
  button.disabled = true
  open()
  try {
    const request = await sendMessage({ type: 'claim-x-analytics-capture' })
    button.disabled = false
    if (
      request.type === 'x-analytics-auto-capture' &&
      request.autoCapture &&
      request.twitterUsername
    ) {
      expectedUsername = request.twitterUsername
      await saveCapture(button, status, expectedUsername, network)
    }
  } catch {
    button.disabled = false
    fail(status, '插件连接异常，请刷新页面后重试。')
  }
}

async function saveCapture(
  button: HTMLButtonElement,
  status: HTMLElement,
  expectedUsername?: string,
  network?: ReturnType<typeof createAnalyticsNetworkReader>['get'],
): Promise<void> {
  if (button.disabled) return
  button.disabled = true
  status.dataset.error = 'false'
  status.textContent = '正在切换到 3M 并等待分析接口响应…'
  let stage: 'read' | 'account' | 'save' = 'read'
  try {
    const result = await waitForThreeMonthCapture({
      root: document,
      network,
      selectRange: true,
      timeoutMs: 30_000,
      stableForMs: 1000,
    })
    if (result.apiError) {
      const explanations: Record<string, string> = {
        HTTP_401: 'X 登录状态已失效，请重新登录 X 后重试。',
        HTTP_403: 'X 拒绝了分析请求，请检查该账号是否能正常访问分析功能。',
        HTTP_404:
          'X 分析接口返回 404，未找到请求的资源；无法仅凭此判断账号是否受限。',
        HTTP_429: 'X 请求过于频繁，请稍后重试。',
        GRAPHQL:
          'X 分析接口返回了业务错误，未取得完整数据。请在 X 分析页重试。',
        SCHEMA:
          'X 分析响应缺少必要字段或结构不受支持，请联系客服检查插件兼容性。',
        NETWORK: 'X 分析请求未完成，请检查网络后重试。',
      }
      return fail(
        status,
        `${explanations[result.apiError] ?? 'X 分析服务暂时异常，请稍后重试。'} 本次未保存。（${result.apiError}）`,
      )
    }
    if (result.pageError)
      return fail(
        status,
        'X 分析页加载失败，本次未采集或保存。页面提示“出错了”，未提供具体原因；请先关闭弹窗，在 X 页面点击 Retry（重试）或刷新，确认数据恢复后再重试采集。',
      )
    if (!result.rangeSelected)
      return fail(
        status,
        '暂时无法读取 X 分析页，请确认已登录且可以访问账号分析，然后点击重试。',
      )
    if (!result.capture && result.missing.includes('networkResponse'))
      return fail(
        status,
        '未收到可验证的近 90 天分析响应，本次未保存。请刷新 X 分析页后重试；若仍失败，请联系客服检查接口兼容性。',
      )
    if (!result.capture && result.missing.includes('periodRefresh'))
      return fail(
        status,
        '尚未确认 3M 数据刷新完成，本次未保存。请等待加载完成后重试；若仍无变化，请刷新 X 分析页。',
      )
    if (!result.capture)
      return fail(
        status,
        `部分数据未能读取（${result.missing.map((key) => metricLabels[key] ?? key).join('、')}），请等待页面加载完成后重试。`,
      )
    const page = result.capture

    if (
      expectedUsername &&
      page.twitterUsername.toLowerCase() !== expectedUsername.toLowerCase()
    )
      return fail(
        status,
        `当前是 @${page.twitterUsername}，请切换到申请账号 @${expectedUsername} 后重试。`,
      )
    stage = 'account'
    status.textContent = '数据已读取，正在核对绑定账号…'
    const account = await sendMessage({ type: 'get-x-analytics-status' })
    if (account.type !== 'x-analytics-status')
      return fail(status, '插件连接异常，请刷新页面后重试。')
    if (!account.twitterUserId || !account.twitterUsername)
      return fail(status, '请先在 Lighthouse 绑定你的 X 账号。')
    if (
      account.twitterUsername.toLowerCase() !==
      page.twitterUsername.toLowerCase()
    )
      return fail(
        status,
        `当前是 @${page.twitterUsername}，请切换到已绑定的 @${account.twitterUsername}。`,
      )

    if (page.twitterUserId && page.twitterUserId !== account.twitterUserId)
      return fail(
        status,
        '分析响应的账号与 Lighthouse 绑定账号不一致，本次未保存。请切换到绑定账号后重新采集。',
      )
    const capturedAt = new Date()
    stage = 'save'
    status.textContent = '数据已读取，正在保存到 Lighthouse…'
    const saved = await sendMessage({
      type: 'save-x-analytics',
      captureId: crypto.randomUUID(),
      twitterUsername: page.twitterUsername,
      ...(page.periodStart && page.periodEnd
        ? { periodStart: page.periodStart, periodEnd: page.periodEnd }
        : rollingNinetyDayPeriod(capturedAt)),
      capturedAt: capturedAt.toISOString(),
      metrics: page.metrics,
    })
    if (saved.type !== 'x-analytics-save-result' || !saved.ok) {
      const code =
        saved.type === 'x-analytics-save-result' ? saved.code : 'NETWORK'
      const message = {
        NO_TOKEN: '请先连接 Lighthouse 插件账号。',
        WRONG_X_ACCOUNT: '当前 X 账号与 Lighthouse 绑定账号不一致。',
        INCOMPLETE: '数据不完整，请刷新 X 分析页后重试。',
        NETWORK: '保存失败，请检查网络后重试。',
      }[code]
      return fail(status, message)
    }
    status.textContent = '已保存到 KOL 资料，请返回 Lighthouse 提交严选申请。'
    button.textContent = '重新采集并保存'
  } catch {
    fail(
      status,
      {
        read: '读取 X 页面失败，尚未保存。请刷新 X 分析页后重试。',
        account:
          '无法核对 Lighthouse 绑定账号，尚未保存。请检查插件连接后重试。',
        save: '未能确认保存结果。请检查 Lighthouse 申请页的采集状态；若未更新，请重试。',
      }[stage],
    )
  } finally {
    if (status.dataset.error === 'true') button.textContent = '重试采集'
    button.disabled = false
  }
}

function fail(status: HTMLElement, message: string): void {
  status.dataset.error = 'true'
  status.textContent = message
}
