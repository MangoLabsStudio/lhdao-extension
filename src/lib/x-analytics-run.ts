import { sendMessage } from './messaging'
import {
  rollingNinetyDayPeriod,
  waitForThreeMonthCapture,
} from './x-analytics-capture'
import type { createAnalyticsNetworkReader } from './x-analytics-network'

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

export async function runAnalyticsCapture(
  report: (
    phase: 'reading' | 'account' | 'saving' | 'error',
    message: string,
  ) => Promise<void>,
  expectedUsername: string,
  network?: ReturnType<typeof createAnalyticsNetworkReader>['get'],
): Promise<void> {
  const fail = (message: string) => report('error', message)
  let stage: 'read' | 'account' | 'save' = 'read'
  try {
    await report('reading', '正在切换到 3M 并等待分析接口响应…')
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
        `${explanations[result.apiError] ?? 'X 分析服务暂时异常，请稍后重试。'} 本次未保存。（${result.apiError}）`,
      )
    }
    if (result.pageError)
      return fail(
        'X 分析页加载失败，本次未采集或保存。页面提示“出错了”，未提供具体原因；请打开 X 分析页点击 Retry（重试）或检查登录状态，再回到采集窗口重试。',
      )
    if (!result.rangeSelected)
      return fail(
        '暂时无法读取 X 分析页，请确认已登录且可以访问账号分析，然后点击重试。',
      )
    if (!result.capture && result.missing.includes('networkResponse'))
      return fail(
        '未收到可验证的近 90 天分析响应，本次未保存。请刷新 X 分析页后重试；若仍失败，请联系客服检查接口兼容性。',
      )
    if (!result.capture && result.missing.includes('periodRefresh'))
      return fail(
        '尚未确认 3M 数据刷新完成，本次未保存。请等待加载完成后重试；若仍无变化，请刷新 X 分析页。',
      )
    if (!result.capture)
      return fail(
        `部分数据未能读取（${result.missing.map((key) => metricLabels[key] ?? key).join('、')}），请等待页面加载完成后重试。`,
      )
    const page = result.capture

    if (
      expectedUsername &&
      page.twitterUsername.toLowerCase() !== expectedUsername.toLowerCase()
    )
      return fail(
        `当前是 @${page.twitterUsername}，请切换到申请账号 @${expectedUsername} 后重试。`,
      )
    stage = 'account'
    await report('account', '数据已读取，正在核对绑定账号…')
    const account = await sendMessage({ type: 'get-x-analytics-status' })
    if (account.type !== 'x-analytics-status')
      return fail('插件连接异常，请刷新页面后重试。')
    if (!account.twitterUserId || !account.twitterUsername)
      return fail('请先在 Lighthouse 绑定你的 X 账号。')
    if (
      account.twitterUsername.toLowerCase() !==
      page.twitterUsername.toLowerCase()
    )
      return fail(
        `当前是 @${page.twitterUsername}，请切换到已绑定的 @${account.twitterUsername}。`,
      )

    if (page.twitterUserId && page.twitterUserId !== account.twitterUserId)
      return fail(
        '分析响应的账号与 Lighthouse 绑定账号不一致，本次未保存。请切换到绑定账号后重新采集。',
      )
    const capturedAt = new Date()
    stage = 'save'
    await report('saving', '数据已读取，正在保存到 Lighthouse…')
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
        INCOMPLETE:
          '数据已读取，但保存校验未通过。请重新开始采集；仍失败请联系支持。',
        NETWORK: '保存失败，请检查网络后重试。',
      }[code]
      return fail(
        saved.type === 'x-analytics-save-result' && !saved.ok && saved.message
          ? saved.message
          : message,
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
    ).catch(() => {})
  }
}
