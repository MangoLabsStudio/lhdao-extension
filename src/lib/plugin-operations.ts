import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  AVAILABLE_TWEETS_QUERY,
  CREATE_AUTO_REINVEST_MUTATION,
  CREATE_EXTENSION_PAIRING_MUTATION,
  CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
  LIGHTHOUSE_MEMBERS_QUERY,
  ME_QUERY,
  MINT_ENGAGEMENT_TICKET_MUTATION,
  MY_RESERVED_ENGAGEMENTS_QUERY,
  POLL_EXTENSION_PAIRING_QUERY,
  PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
  PROMOTE_TWEET_MUTATION,
  RECORD_TWEET_DWELL_MUTATION,
  REPORT_ENGAGEMENT_CAPTURE_MUTATION,
  RESERVE_TIMELINE_SLOT_MUTATION,
  SUBMIT_ENGAGEMENT_PROOF_MUTATION,
} from './queries'

export type PluginOperationPermission =
  | 'public'
  | 'read'
  | 'capture'
  | 'verify'
  | 'spend'

export interface PluginOperationDefinition {
  id: string
  operationName: string
  document: string
  documentSha256: string
  permission: PluginOperationPermission
  version: 1
}

export const PLUGIN_OPERATIONS: readonly PluginOperationDefinition[] = [
  operation(
    'x-analytics.me.v1',
    'MyXAnalytics',
    'query MyXAnalytics { myXAnalytics }',
    'c190cf7109956e3139e95fe8da124fccb93134a1881c1eef00a69f9c981abede',
    'read',
  ),
  operation(
    'x-analytics.save.v1',
    'SaveXAnalytics',
    'mutation SaveXAnalytics($input: XAnalyticsInput!) { saveXAnalytics(input: $input) }',
    '8d35391bae27777c1b20394ce8ed07ef320b383c788209dffc656b2950c3a1e5',
    'capture',
  ),
  operation(
    'pairing.create.v1',
    'CreateExtensionPairing',
    CREATE_EXTENSION_PAIRING_MUTATION,
    '1e66a6973dc91f550e917f5bd7f32ffa8c53b84e1a86ae7208f14de06e99476f',
    'public',
  ),
  operation(
    'pairing.poll.v1',
    'PollExtensionPairing',
    POLL_EXTENSION_PAIRING_QUERY,
    '587a365e3bc5df3ae67ca32933fd2b375a28a919a0b3fe272339a51af2004d32',
    'public',
  ),
  operation(
    'user.me.v2',
    'Me',
    ME_QUERY,
    'f94fc406861a3e12f778bfd2949c2ef0b938513a03c5e10f5bf124fa08c35138',
    'read',
  ),
  operation(
    'engagement.available.v5',
    'AvailableEngagements',
    AVAILABLE_ENGAGEMENTS_QUERY,
    '3967059a45ff7b280ac28d81a08ef55d5e3ebab8142dec8364ec8b37ff2b2e33',
    'read',
  ),
  operation(
    'engagement.reserved.v4',
    'MyReservedEngagements',
    MY_RESERVED_ENGAGEMENTS_QUERY,
    'ad0f06baa90f9fca37a767edcceac685d3d7abe5a7818c871086869af27b402d',
    'read',
  ),
  operation(
    'tweet.available.v2',
    'AvailableTweets',
    AVAILABLE_TWEETS_QUERY,
    'bcc1070a66d0f1e9ac73aacfa237c4bc63de01f1f2a70a687bc6fe374af1c63f',
    'read',
  ),
  operation(
    'member.lookup.v1',
    'LighthouseMembers',
    LIGHTHOUSE_MEMBERS_QUERY,
    '4baca714e67633ca1cb41c29c755a759894e94e5bcf172309966ae536bad5de2',
    'read',
  ),
  operation(
    'dwell.record.v1',
    'RecordTweetDwell',
    RECORD_TWEET_DWELL_MUTATION,
    '8a9aaf0742639644b9fd3d00e85ba325b565f24fc50404e58110cec1ddec4f6f',
    'capture',
  ),
  operation(
    'capture.report.v1',
    'ReportEngagementCapture',
    REPORT_ENGAGEMENT_CAPTURE_MUTATION,
    'ac20d8831c6a46f02358310b47efc77aa380c55b89b68762dbebbaf8f950e428',
    'capture',
  ),
  operation(
    'verify.ticket.v1',
    'MintEngagementTicket',
    MINT_ENGAGEMENT_TICKET_MUTATION,
    'c027edef4e02d39efb08a0ed8e9903fbafdc5fcc7a1ea374f1b9c564c93b001b',
    'verify',
  ),
  operation(
    'verify.proof.v1',
    'SubmitEngagementProof',
    SUBMIT_ENGAGEMENT_PROOF_MUTATION,
    '3545cd4cbfbc22c5738fb9c9423d8c0e62a20809e0887183106c40c2ca3814de',
    'verify',
  ),
  operation(
    'engagement.reserve.v2',
    'ReserveTimelineEngagementSlot',
    RESERVE_TIMELINE_SLOT_MUTATION,
    '685a352783b4f11583bdade794f9f4864e95acd62383601fc21c807df57b5752',
    'verify',
  ),
  operation(
    'read.engagement-current-prices.v1',
    'CurrentEngagementMarketPrices',
    CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
    'a6db29afa57f31cacc46403504c8c43f0ac10ac5fabfce5fe89f6ee269d1b312',
    'read',
  ),
  operation(
    'read.promote-pricing.v3',
    'PreviewPromoteTweetPricing',
    PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
    '427dfd9325327ac2299660166085fa0aa7bc9436eba4c52c75294a620a755760',
    'read',
  ),
  operation(
    'spend.promote.v1',
    'PromoteTweet',
    PROMOTE_TWEET_MUTATION,
    '4c5bc826b9b9c90b8d1b035e449a47e720c6536f4c6f40337a9af10361b5876c',
    'spend',
  ),
  operation(
    'spend.reinvest.v1',
    'CreateAutoReinvestTask',
    CREATE_AUTO_REINVEST_MUTATION,
    'a0c6556c6b608b355ef18f961fe8733e1ee59b2e89bc8c319422568a742bf855',
    'spend',
  ),
]

const operationsByDocument = new Map<
  string,
  Map<string, PluginOperationDefinition>
>()
for (const definition of PLUGIN_OPERATIONS) {
  const operationsByName =
    operationsByDocument.get(definition.document) ??
    new Map<string, PluginOperationDefinition>()
  operationsByName.set(definition.operationName, definition)
  operationsByDocument.set(definition.document, operationsByName)
}

export function getPluginOperationByDocument(
  document: string,
  operationName: string,
): PluginOperationDefinition | undefined {
  return operationsByDocument.get(document)?.get(operationName)
}

function operation(
  id: string,
  operationName: string,
  document: string,
  documentSha256: string,
  permission: PluginOperationPermission,
): PluginOperationDefinition {
  return {
    id,
    operationName,
    document,
    documentSha256,
    permission,
    version: 1,
  }
}
