import { sendMessage } from '@/lib/messaging'
import { evaluateProductExperienceRules } from '@/lib/product-experience'

const submittedCampaignIds = new Set<string>()
let scanTimer: ReturnType<typeof setTimeout> | null = null
let scanning = false

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    scheduleScan(0)
    const observer = new MutationObserver(() => scheduleScan(250))
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    window.addEventListener('hashchange', () => scheduleScan(0))
    window.addEventListener('popstate', () => scheduleScan(0))
  },
})

function scheduleScan(delayMs: number): void {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = setTimeout(() => {
    scanTimer = null
    void scanCurrentPage()
  }, delayMs)
}

async function scanCurrentPage(): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const response = await sendMessage({
      type: 'get-product-experience-task-for-url',
      href: window.location.href,
    })
    if (response.type !== 'product-experience-task-for-url' || !response.task) {
      return
    }
    const task = response.task
    if (
      task.completionMode !== 'ALL' ||
      submittedCampaignIds.has(task.campaignId)
    ) {
      return
    }

    const result = await evaluateProductExperienceRules({
      href: window.location.href,
      rules: task.rules,
    })
    if (result.ruleMatches.length !== task.rules.length) return

    submittedCampaignIds.add(task.campaignId)
    const submit = await sendMessage({
      type: 'submit-product-experience-matches',
      campaignId: task.campaignId,
      ruleMatches: result.ruleMatches,
    })
    if (
      submit.type !== 'product-experience-submit-result' ||
      submit.ok !== true
    ) {
      submittedCampaignIds.delete(task.campaignId)
    }
  } catch {
    // 目标网页上静默失败,避免影响客户产品本身;用户可回 Lighthouse 页重试。
  } finally {
    scanning = false
  }
}
