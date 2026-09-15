import { sendMessage } from '@/lib/messaging'
import {
  diagnoseXAnalyticsPage,
  findThreeMonthButton,
  rollingNinetyDayPeriod,
} from '@/lib/x-analytics-capture'

const HOST_ID = 'lhdao-x-analytics-capture'

export default defineContentScript({
  matches: [
    'https://x.com/i/account_analytics*',
    'https://twitter.com/i/account_analytics*',
  ],
  runAt: 'document_idle',
  main() {
    mountCaptureCard()
  },
})

function mountCaptureCard(): void {
  if (document.getElementById(HOST_ID)) return
  const host = document.createElement('div')
  host.id = HOST_ID
  const shadow = host.attachShadow({ mode: 'closed' })
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      aside {
        position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;
        width: 280px; box-sizing: border-box; padding: 16px;
        border: 1px solid #d7e5e3; border-radius: 16px;
        background: rgba(255,255,255,.98); color: #0f172a;
        box-shadow: 0 16px 44px rgba(15,23,42,.18);
        font: 13px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      }
      strong { display: block; margin-bottom: 4px; font-size: 15px; }
      p { margin: 0 0 12px; color: #475569; }
      button {
        width: 100%; border: 0; border-radius: 999px; padding: 10px 14px;
        background: #0f766e; color: white; cursor: pointer; font: inherit;
        font-weight: 700;
      }
      button:disabled { cursor: wait; opacity: .65; }
      [role="status"] { min-height: 19px; margin-top: 9px; color: #0f766e; }
      [data-error="true"] { color: #b42318; }
      @media (prefers-color-scheme: dark) {
        aside { background: rgba(15,23,42,.98); color: #f8fafc; border-color: #334155; }
        p { color: #cbd5e1; }
      }
    </style>
    <aside aria-label="Lighthouse X 数据采集">
      <strong>Lighthouse · 近三个月 X 数据</strong>
      <p>固定读取 X 的 3M 账号汇总，成功后直接保存到你的 KOL 资料。</p>
      <button type="button">采集并保存</button>
      <div role="status" aria-live="polite"></div>
    </aside>
  `
  document.documentElement.appendChild(host)
  const button = shadow.querySelector('button')!
  const status = shadow.querySelector<HTMLElement>('[role="status"]')!
  button.addEventListener('click', () => {
    void saveCapture(button, status)
  })
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
    const diagnostic = await waitForCompleteCapture()
    if (!diagnostic.capture)
      return fail(
        status,
        `汇总数据不完整（未识别：${diagnostic.missing.join(', ')}）。`,
      )
    const page = diagnostic.capture

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
    status.textContent = '已保存到 KOL 资料，现在可以返回任务广场接单。'
    button.textContent = '重新采集并保存'
  } catch {
    fail(status, '采集失败，请刷新页面后重试。')
  } finally {
    button.disabled = false
  }
}

async function waitForCompleteCapture(): Promise<
  ReturnType<typeof diagnoseXAnalyticsPage>
> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const diagnostic = diagnoseXAnalyticsPage(document)
    if (diagnostic.capture) return diagnostic
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return diagnoseXAnalyticsPage(document)
}

function fail(status: HTMLElement, message: string): void {
  status.dataset.error = 'true'
  status.textContent = message
}
