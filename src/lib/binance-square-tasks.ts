import type { AvailableEngagement } from './queries'
import type {
  BinanceSquareActionType,
  BinanceSquareTaskCache,
  BinanceSquareTaskIndex,
} from './storage'

const supportedActions = new Set<BinanceSquareActionType>([
  'LIKE',
  'COMMENT',
  'SHARE',
  'FOLLOW',
])

export function indexBinanceSquareTasks(
  campaigns: AvailableEngagement[],
  reservedCampaignIds: Set<string> = new Set(),
): BinanceSquareTaskIndex {
  const byContentId: BinanceSquareTaskIndex['byContentId'] = {}
  const byAuthorId: BinanceSquareTaskIndex['byAuthorId'] = {}

  for (const campaign of campaigns) {
    if (
      campaign.type !== 'ENGAGEMENT' ||
      campaign.platform !== 'BINANCE_SQUARE' ||
      !campaign.targetUrl
    ) {
      continue
    }

    for (const action of campaign.actions) {
      if (!supportedActions.has(action.actionType as BinanceSquareActionType)) {
        continue
      }

      const task: BinanceSquareTaskCache = {
        campaignId: campaign.id,
        actionType: action.actionType as BinanceSquareActionType,
        targetUrl: campaign.targetUrl,
        ...(campaign.targetContentId
          ? { targetContentId: campaign.targetContentId }
          : {}),
        ...(campaign.targetAuthorId
          ? { targetAuthorId: campaign.targetAuthorId }
          : {}),
        reserved: reservedCampaignIds.has(campaign.id),
      }

      if (campaign.targetContentId) {
        const tasks = byContentId[campaign.targetContentId] ?? []
        tasks.push(task)
        byContentId[campaign.targetContentId] = tasks
      }
      if (campaign.targetAuthorId) {
        const tasks = byAuthorId[campaign.targetAuthorId] ?? []
        tasks.push(task)
        byAuthorId[campaign.targetAuthorId] = tasks
      }
    }
  }

  return { byContentId, byAuthorId }
}

export function reservedBinanceProbeTargets(
  index: BinanceSquareTaskIndex,
): Array<{ kind: 'CONTENT' | 'AUTHOR'; id: string }> {
  const targets = [
    ...Object.entries(index.byContentId)
      .filter(([, tasks]) => tasks.some((task) => task.reserved))
      .map(([id]) => ({ kind: 'CONTENT' as const, id })),
    ...Object.entries(index.byAuthorId)
      .filter(([, tasks]) => tasks.some((task) => task.reserved))
      .map(([id]) => ({ kind: 'AUTHOR' as const, id })),
  ]

  return targets.sort((a, b) =>
    `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
  )
}
