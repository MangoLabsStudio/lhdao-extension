import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  AVAILABLE_TWEETS_QUERY,
  CREATE_AUTO_REINVEST_MUTATION,
  CREATE_EXTENSION_PAIRING_MUTATION,
  CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
  LIGHTHOUSE_MEMBERS_QUERY,
  ME_QUERY,
  MINT_ENGAGEMENT_TICKET_MUTATION,
  MintProductExperienceTestTicketOperationName,
  MintProductExperienceTicketOperationName,
  MY_RESERVED_ENGAGEMENTS_QUERY,
  POLL_EXTENSION_PAIRING_QUERY,
  PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
  PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
  PROMOTE_TWEET_MUTATION,
  ProductZkTlsRuleProgressOperationName,
  RECORD_TWEET_DWELL_MUTATION,
  REPORT_ENGAGEMENT_CAPTURE_MUTATION,
  StartProductZkTlsProofOperationName,
  StartProductZkTlsTestProofOperationName,
  SUBMIT_ENGAGEMENT_PROOF_MUTATION,
  SubmitProductExperienceProofOperationName,
} from './queries'

const PRODUCT_EXPERIENCE_DOCUMENT_SHA256 =
  'afa8256b861be2b084ac8976478a14bd716d50473c203ca87e62868cce720577'

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
    'user.me.v1',
    'Me',
    ME_QUERY,
    'e2cf4ae81a912d91fcdc244de44253fc2408cc4bca9b95908691fd89c742143c',
    'read',
  ),
  operation(
    'engagement.available.v3',
    'AvailableEngagements',
    AVAILABLE_ENGAGEMENTS_QUERY,
    'd485116ba43089569fafcc64ef6adfc11fba3e99b32ca7feb9f7f51ff031bfc4',
    'read',
  ),
  operation(
    'engagement.reserved.v3',
    'MyReservedEngagements',
    MY_RESERVED_ENGAGEMENTS_QUERY,
    'fcf29cf3c29216c092a20a03a190f4e99f2992591b3ae078365ad948b0fb90ea',
    'read',
  ),
  operation(
    'tweet.available.v1',
    'AvailableTweets',
    AVAILABLE_TWEETS_QUERY,
    'd921d07d7b2a4d40382ec501ef25b688a85ab6421a60a2fb45444ff4e86b5433',
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
    'read.engagement-current-prices.v1',
    'CurrentEngagementMarketPrices',
    CURRENT_ENGAGEMENT_MARKET_PRICES_QUERY,
    'a6db29afa57f31cacc46403504c8c43f0ac10ac5fabfce5fe89f6ee269d1b312',
    'read',
  ),
  operation(
    'read.promote-pricing.v2',
    'PreviewPromoteTweetPricing',
    PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
    'd71bdd5a31703929fc61a7408b167668f558c16840c340ce8073248b8190e934',
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
  operation(
    'verify.product-experience.ticket.v2',
    MintProductExperienceTicketOperationName,
    PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
    PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
    'verify',
  ),
  operation(
    'verify.product-experience.test-ticket.v2',
    MintProductExperienceTestTicketOperationName,
    PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
    PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
    'verify',
  ),
  operation(
    'verify.product-experience.proof.v2',
    SubmitProductExperienceProofOperationName,
    PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
    PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
    'verify',
  ),
  operation(
    'verify.product-experience.zktls-start.v1',
    StartProductZkTlsProofOperationName,
    PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
    PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
    'verify',
  ),
  operation(
    'verify.product-experience.zktls-test-start.v1',
    StartProductZkTlsTestProofOperationName,
    PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
    PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
    'verify',
  ),
  operation(
    'read.product-experience.zktls-progress.v1',
    ProductZkTlsRuleProgressOperationName,
    PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
    PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
    'read',
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
