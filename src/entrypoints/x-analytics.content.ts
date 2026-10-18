import { sendMessage } from '@/lib/messaging'
import { createAnalyticsNetworkReader } from '@/lib/x-analytics-network'
import { runAnalyticsCapture } from '@/lib/x-analytics-run'

export default defineContentScript({
  matches: [
    'https://x.com/i/account_analytics*',
    'https://twitter.com/i/account_analytics*',
  ],
  runAt: 'document_start',
  async main(ctx) {
    // Observe early responses, but never render UI or collect without a website request.
    const network = createAnalyticsNetworkReader(window)
    ctx.onInvalidated?.(() => network.dispose())
    try {
      const request = await sendMessage({ type: 'claim-x-analytics-capture' })
      if (
        request.type !== 'x-analytics-auto-capture' ||
        !request.autoCapture ||
        !request.twitterUsername
      )
        return
      await runAnalyticsCapture(
        async (phase, message, details) => {
          const response = await sendMessage({
            type: 'x-analytics-progress',
            phase,
            message,
            details: { ...details, runId: request.runId },
          })
          if (response.type !== 'ack') throw new Error('Capture ended')
        },
        request.twitterUsername,
        network.get,
        { runId: request.runId, resume: request.resume },
      )
    } finally {
      network.dispose()
    }
  },
})
