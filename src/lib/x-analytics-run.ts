import { sendMessage } from './messaging'
import {
  rollingNinetyDayPeriod,
  type ThreeMonthCaptureResult,
  waitForThreeMonthCapture,
  type XAnalyticsPageCapture,
} from './x-analytics-capture'
import type { createAnalyticsNetworkReader } from './x-analytics-network'

import {
  type AnalyticsPreview,
  type AnalyticsSavePayload,
  type CaptureProgress,
  metricLabels,
} from './x-analytics-recovery'

export async function runAnalyticsCapture(
  report: (
    phase: 'reading' | 'account' | 'saving' | 'error',
    message: string,
    details?: CaptureProgress,
  ) => Promise<void>,
  expectedUsername: string,
  network?: ReturnType<typeof createAnalyticsNetworkReader>['get'],
  recovery: { runId?: string; resume?: AnalyticsSavePayload } = {},
): Promise<void> {
  let preview: AnalyticsPreview | undefined
  const fail = (message: string, retryable = false, discardSave = false) =>
    report('error', message, { retryable, discardSave, preview })
  let stage: 'read' | 'account' | 'save' = 'read'
  try {
    await report(
      'reading',
      recovery.resume
        ? '正在恢复已读取数据的保存…'
        : '正在切换到 3M 并等待分析接口响应…',
    )
    const result: ThreeMonthCaptureResult = recovery.resume
      ? {
          capture: {
            twitterUsername: recovery.resume.twitterUsername,
            periodStart: recovery.resume.periodStart,
            periodEnd: recovery.resume.periodEnd,
            metrics: recovery.resume
              .metrics as XAnalyticsPageCapture['metrics'],
          },
          rangeSelected: true,
          missing: [],
        }
      : await waitForThreeMonthCapture({
          root: document,
          network,
          selectRange: true,
          timeoutMs: 30_000,
          stableForMs: 1000,
        })
    if ('preview' in result) preview = result.preview
    if ('apiError' in result && result.apiError) {
      const explanations: Record<string, string> = {
        HTTP_401: 'X 登录状态已失效，请重新登录 X 后重试。',
        HTTP_403: 'X 拒绝了分析请求，请检查该账号是否能正常访问分析功能。',
        HTTP_404:
          'X 分析接口返回 404，未找到请求的资源；无法仅凭此判断账号是否受限。',
        HTTP_429: 'X 请求过于频繁，请稍后重试。',
        GRAPHQL:
          'X 分析接口返回了业务错误，未取得完整数据。请在 X 分析页重试。',
        SCHEMA: preview
          ? 'X 分析响应缺少必要字段，已保留可读取的部分。'
          : 'X 分析响应缺少可核对的账号标识，暂不能确认数据归属。',
        NETWORK: 'X 分析请求未完成，请检查网络后重试。',
      }
      return fail(
        `${explanations[result.apiError] ?? 'X 分析服务暂时异常，请稍后重试。'} 本次未保存。（${result.apiError}）`,
        /^(NETWORK|SCHEMA|GRAPHQL|HTTP_5\d\d)$/.test(result.apiError),
      )
    }
    if ('pageError' in result && result.pageError)
      return fail(
        'X 分析页加载失败，本次未采集或保存。页面提示“出错了”，未提供具体原因；请打开 X 分析页点击 Retry（重试）或检查登录状态，再回到采集窗口重试。',
        true,
      )
    if (!result.rangeSelected)
      return fail(
        '暂时无法读取 X 分析页，请确认已登录且可以访问账号分析，然后点击重试。',
        true,
      )
    if (!result.capture && result.missing.includes('networkResponse'))
      return fail(
        '未收到可验证的近 90 天分析响应，本次未保存。请刷新 X 分析页后重试；若仍失败，请联系客服检查接口兼容性。',
        true,
      )
    if (!result.capture && result.missing.includes('periodRefresh'))
      return fail(
        '尚未确认 3M 数据刷新完成，本次未保存。请等待加载完成后重试；若仍无变化，请刷新 X 分析页。',
        true,
      )
    if (!result.capture)
      return fail(
        `部分数据未能读取（${result.missing.map((key) => metricLabels[key as keyof typeof metricLabels] ?? key).join('、')}），请等待页面加载完成后重试。`,
        true,
      )
    const page = result.capture

    if (
      expectedUsername &&
      page.twitterUsername.toLowerCase() !== expectedUsername.toLowerCase()
    )
      return fail(
        `当前是 @${page.twitterUsername}，请切换到申请账号 @${expectedUsername} 后重试。`,
      )
    if (page.twitterUserId && page.periodStart && page.periodEnd)
      preview = {
        twitterUserId: page.twitterUserId,
        from: Date.parse(page.periodStart),
        to: Date.parse(page.periodEnd) + 86_400_000,
        metrics: page.metrics,
      }
    stage = 'account'
    await report('account', '数据已读取，正在核对绑定账号…', { preview })
    const account = await sendMessage({ type: 'get-x-analytics-status' })
    if (account.type !== 'x-analytics-status')
      return fail(
        account.type === 'x-analytics-save-result' &&
          !account.ok &&
          account.message
          ? account.message
          : '插件连接异常，请刷新页面后重试。',
        account.type === 'x-analytics-save-result' &&
          !account.ok &&
          account.code === 'NETWORK' &&
          account.retryable !== false,
      )
    if (!account.twitterUserId || !account.twitterUsername)
      return fail('请先在 Lighthouse 绑定你的 X 账号。')
    if (
      account.twitterUsername.toLowerCase() !==
      page.twitterUsername.toLowerCase()
    )
      return fail(
        `当前是 @${page.twitterUsername}，请切换到已绑定的 @${account.twitterUsername}。`,
      )

    if (
      'twitterUserId' in page &&
      page.twitterUserId &&
      page.twitterUserId !== account.twitterUserId
    )
      return fail(
        '分析响应的账号与 Lighthouse 绑定账号不一致，本次未保存。请切换到绑定账号后重新采集。',
      )
    const capturedAt = new Date()
    const payload: AnalyticsSavePayload = recovery.resume ?? {
      captureId: crypto.randomUUID(),
      twitterUsername: page.twitterUsername,
      ...(page.periodStart && page.periodEnd
        ? { periodStart: page.periodStart, periodEnd: page.periodEnd }
        : rollingNinetyDayPeriod(capturedAt)),
      capturedAt: capturedAt.toISOString(),
      metrics: page.metrics,
    }
    preview = {
      twitterUserId: account.twitterUserId,
      from: Date.parse(payload.periodStart),
      to: Date.parse(payload.periodEnd) + 86_400_000,
      metrics: page.metrics,
    }
    stage = 'save'
    await report('saving', '数据已读取，正在保存到 Lighthouse…', { preview })
    const saved = await sendMessage({
      type: 'save-x-analytics',
      ...payload,
      runId: recovery.runId,
    })
    if (saved.type !== 'x-analytics-save-result' || !saved.ok) {
      const code =
        saved.type === 'x-analytics-save-result' ? saved.code : 'NETWORK'
      const message = {
        NO_TOKEN: '请先连接 Lighthouse 插件账号。',
        WRONG_X_ACCOUNT: '当前 X 账号与 Lighthouse 绑定账号不一致。',
        INCOMPLETE:
          '数据已读取，但保存校验未通过。请重新开始采集；仍失败请联系支持。',
        NETWORK: '保存失败，请检查网络后重试。',
      }[code]
      return fail(
        saved.type === 'x-analytics-save-result' && !saved.ok && saved.message
          ? saved.message
          : message,
        code === 'NETWORK' &&
          !(
            saved.type === 'x-analytics-save-result' &&
            !saved.ok &&
            saved.retryable === false
          ),
        code === 'INCOMPLETE' || code === 'WRONG_X_ACCOUNT',
      )
    }
  } catch {
    await fail(
      {
        read: '读取 X 页面失败，尚未保存。请刷新 X 分析页后重试。',
        account:
          '无法核对 Lighthouse 绑定账号，尚未保存。请检查插件连接后重试。',
        save: '未能确认保存结果。请检查 Lighthouse 申请页的采集状态；若未更新，请重试。',
      }[stage],
      true,
    ).catch(() => {})
  }
}
