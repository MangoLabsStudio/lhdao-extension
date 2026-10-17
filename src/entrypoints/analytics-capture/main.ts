import { sendMessage } from '@/lib/messaging'
import type { CaptureRequest } from '@/lib/x-analytics-auto-capture'
import './style.css'

const tabId = Number(new URLSearchParams(location.search).get('tabId'))
const key = `x-analytics-request:${tabId}`
const account = document.querySelector<HTMLElement>('#account')!
const phase = document.querySelector<HTMLElement>('#phase')!
const status = document.querySelector<HTMLElement>('#status')!
const progress = document.querySelector<HTMLElement>('#progress')!
const retry = document.querySelector<HTMLButtonElement>('#retry')!
const showPage = document.querySelector<HTMLButtonElement>('#show-page')!
const icon = document.querySelector<HTMLElement>('#progress-icon')!
let request: CaptureRequest | undefined
const phases = {
  loading: ['准备采集', '12%'],
  reading: ['正在读取 3M 数据', '38%'],
  account: ['正在核对绑定账号', '65%'],
  saving: ['正在保存账号资料', '88%'],
  error: ['采集未完成', '0%'],
}

function render() {
  const current = request
  const timedOut = current && current.deadline <= Date.now()
  const ended = !current || current.expiresAt <= Date.now()
  const error = !ended && (current.phase === 'error' || timedOut)
  document.body.dataset.error = String(error)
  account.textContent = current ? `@${current.twitterUsername}` : 'Lighthouse'
  phase.textContent = ended
    ? '采集已结束'
    : error
      ? '采集未完成'
      : phases[current.phase][0]
  status.textContent = ended
    ? '请返回 Lighthouse 查看采集状态，或重新开始采集。'
    : timedOut && current.phase !== 'error'
      ? '等待 X 页面响应超时。请打开分析页检查登录状态和网络，然后重试。'
      : current.message
  progress.style.width = ended || error ? '0%' : phases[current.phase][1]
  retry.hidden = !error
  showPage.disabled = ended
  icon.hidden = ended
}

async function refresh() {
  request = (await chrome.storage.session.get(key))[key] as
    | CaptureRequest
    | undefined
  render()
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && key in changes) void refresh()
})
setInterval(render, 1000)
void refresh()
for (const [button, action] of [
  [retry, 'retry'],
  [showPage, 'show-page'],
] as const) {
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      const response = await sendMessage({
        type: 'x-analytics-window-action',
        tabId,
        action,
      })
      if (response.type !== 'ack') throw new Error('Unavailable')
      await refresh()
    } catch {
      status.textContent =
        '操作未完成，请关闭窗口后从 Lighthouse 重新开始采集。'
    } finally {
      button.disabled = false
    }
  })
}
