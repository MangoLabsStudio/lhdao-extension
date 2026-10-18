import { sendMessage } from '@/lib/messaging'
import type { CaptureRequest } from '@/lib/x-analytics-auto-capture'
import {
  MAX_CAPTURE_ATTEMPTS,
  metricLabels,
  missingMetrics,
} from '@/lib/x-analytics-recovery'
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
const recovery = document.querySelector<HTMLElement>('#recovery')!
const preview = document.querySelector<HTMLElement>('#preview')!
const metrics = document.querySelector<HTMLElement>('#metrics')!
const missing = document.querySelector<HTMLElement>('#missing')!
let request: CaptureRequest | undefined
let acting = false
const phases = {
  loading: ['准备采集', '12%'],
  reading: ['正在读取 3M 数据', '38%'],
  account: ['正在核对绑定账号', '65%'],
  saving: ['正在保存账号资料', '88%'],
  retrying: ['正在恢复采集', '38%'],
  error: ['需要你协助完成', '38%'],
}

function render() {
  const current = request
  const ended = !current || current.expiresAt <= Date.now()
  const timedOut =
    !ended &&
    current.deadline <= Date.now() &&
    !['retrying', 'error'].includes(current.phase)
  const auto =
    !ended &&
    ((current.phase === 'retrying' &&
      (current.retryAt ?? Infinity) <= Date.now()) ||
      timedOut) &&
    current.attempt < MAX_CAPTURE_ATTEMPTS
  const error = !ended && (current.phase === 'error' || (timedOut && !auto))
  document.body.dataset.error = String(error)
  account.textContent = current ? `@${current.twitterUsername}` : 'Lighthouse'
  phase.textContent = ended
    ? '采集已结束'
    : error
      ? '需要你协助完成'
      : phases[current.phase][0]
  status.textContent = ended
    ? '请返回 Lighthouse 查看采集状态，或重新开始采集。'
    : timedOut
      ? '等待 X 页面响应超时，已保留本次读取结果。'
      : current.message
  progress.style.width = ended
    ? '0%'
    : current.savePayload
      ? '88%'
      : current.preview
        ? '65%'
        : phases[current.phase][1]
  recovery.textContent = ended
    ? ''
    : current.phase === 'retrying'
      ? `${Math.max(0, Math.ceil(((current.retryAt ?? Date.now()) - Date.now()) / 1000))} 秒后自动重试 · 第 ${current.attempt + 1} / ${MAX_CAPTURE_ATTEMPTS} 次`
      : error && current.attempt >= MAX_CAPTURE_ATTEMPTS
        ? '已尝试 3 次，请检查分析页后手动重试。'
        : `第 ${current.attempt} / ${MAX_CAPTURE_ATTEMPTS} 次尝试`
  retry.hidden = !error
  showPage.disabled = ended
  icon.hidden = ended
  preview.hidden = ended || !current.preview
  if (!preview.hidden && current?.preview) {
    const absent = current.missing ?? missingMetrics(current.preview)
    metrics.replaceChildren(
      ...Object.entries(metricLabels).map(([key, label]) => {
        const item = document.createElement('div')
        const title = document.createElement('dt')
        const value = document.createElement('dd')
        title.textContent = label
        const n = current.preview!.metrics[key as keyof typeof metricLabels]
        value.textContent =
          typeof n === 'number'
            ? key === 'engagementRate'
              ? `${(n * 100).toFixed(2)}%`
              : n.toLocaleString('zh-CN')
            : key === 'activeFollowers'
              ? '未提供'
              : '待获取'
        if (typeof n === 'number' && absent.includes(key))
          value.textContent += ' · 待更新'
        item.dataset.missing = String(
          typeof n !== 'number' || absent.includes(key),
        )
        item.append(title, value)
        return item
      }),
    )
    missing.textContent = absent.length
      ? `待获取：${absent.map((key) => metricLabels[key as keyof typeof metricLabels]).join('、')}。已读取的数值仅保留在本次会话，完整校验后才会保存。`
      : current.savePayload
        ? '已保留完整读取结果，正在确认保存；网络中断后会继续保存同一份数据。'
        : '已保留读取结果，仍需完成本次数据校验后才能保存。'
  }
  if (auto && !acting) void act('auto-retry')
}
async function refresh() {
  request = (await chrome.storage.session.get(key))[key] as
    | CaptureRequest
    | undefined
  render()
}
async function act(action: 'retry' | 'auto-retry' | 'show-page') {
  if (acting) return
  acting = true
  retry.disabled = true
  try {
    const response = await sendMessage({
      type: 'x-analytics-window-action',
      tabId,
      action,
    })
    if (response.type !== 'ack' && action !== 'auto-retry')
      throw new Error('Unavailable')
    await refresh()
  } catch {
    status.textContent = '操作未完成，已读取的数据仍保留在本次会话，请重试。'
  } finally {
    acting = false
    retry.disabled = false
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && key in changes) void refresh()
})
setInterval(render, 1000)
void refresh()
retry.addEventListener('click', () => void act('retry'))
showPage.addEventListener('click', () => void act('show-page'))
