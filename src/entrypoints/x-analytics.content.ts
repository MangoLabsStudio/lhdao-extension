import { sendMessage } from '@/lib/messaging'
import {
  findThreeMonthButton,
  rollingNinetyDayPeriod,
  waitForThreeMonthCapture,
} from '@/lib/x-analytics-capture'

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
  runAt: 'document_idle',
  main() {
    mountCaptureDialog()
  },
})

function mountCaptureDialog(): void {
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
        max-height: calc(100dvh - 32px); overflow: auto; padding: 28px;
        border: 1px solid #d7e5e3; border-radius: 20px;
        background: #fff; color: #0f172a;
        box-shadow: 0 24px 80px #0f172a33;
      }
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
      button { border: 0; border-radius: 999px; padding: 11px 16px;
        background: #0f766e; color: white; cursor: pointer; font-weight: 700; }
      button:focus-visible { outline: 3px solid #5eead4; outline-offset: 3px; }
      button:disabled { cursor: wait; opacity: .65; }
      [data-capture] { width: 100%; }
      [data-close] { flex-shrink: 0; width: 36px; height: 36px; padding: 0;
        background: #f1f5f9; color: #475569; font-size: 24px; line-height: 1; }
      [data-launch] { display: flex; align-items: center; gap: 8px; position: fixed; right: 24px; top: 24px; z-index: 2147483647;
        box-shadow: 0 4px 20px #0f172a26; }
      [hidden] { display: none !important; }
      [role="status"] { margin-top: 12px; color: #0f766e; overflow-wrap: anywhere; }
      [role="status"]:empty { display: none; }
      [data-error="true"] { color: #b42318; }
      @media (max-width: 480px) {
        dialog { top: 16px; right: 16px; }
        [data-launch] { top: 16px; right: 16px; }
      }
      @media (prefers-color-scheme: dark) {
        dialog { background: #0f172a; color: #f8fafc; border-color: #334155; }
        p { color: #cbd5e1; }
        .brand, [role="status"] { color: #5eead4; }
        .period { background: #134e4a; color: #ccfbf1; }
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
  button.addEventListener('click', () => {
    void saveCapture(button, status)
  })
  open()
}

async function saveCapture(
  button: HTMLButtonElement,
  status: HTMLElement,
): Promise<void> {
  button.disabled = true
  status.dataset.error = 'false'
  status.textContent = '正在切换到 3M 并读取汇总…'
  try {
    const range = findThreeMonthButton(document)
    if (!range) return fail(status, 'X 分析页尚未加载完整，请稍后重试。')
    range.click()
    const result = await waitForThreeMonthCapture({
      root: document,
    })
    if (!result.rangeSelected)
      return fail(
        status,
        '未能确认 3M 已选中，请关闭弹窗，在 X 页面选择 3M 后重试。',
      )
    if (!result.capture)
      return fail(
        status,
        `部分数据未能读取（${result.missing.map((key) => metricLabels[key] ?? key).join('、')}），请等待页面加载完成后重试。`,
      )
    const page = result.capture

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

    const capturedAt = new Date()
    const saved = await sendMessage({
      type: 'save-x-analytics',
      captureId: crypto.randomUUID(),
      twitterUsername: page.twitterUsername,
      ...rollingNinetyDayPeriod(capturedAt),
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
    status.textContent = '已保存到 KOL 资料，可以返回 Lighthouse 继续严选申请。'
    button.textContent = '重新采集并保存'
  } catch {
    fail(status, '采集失败，请刷新页面后重试。')
  } finally {
    button.disabled = false
  }
}

function fail(status: HTMLElement, message: string): void {
  status.dataset.error = 'true'
  status.textContent = message
}
