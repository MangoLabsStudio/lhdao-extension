import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../canonical-json'
import {
  getPluginOperationByDocument,
  PLUGIN_OPERATIONS,
} from '../plugin-operations'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  MintProductExperienceTestTicketOperationName,
  MintProductExperienceTicketOperationName,
  MY_RESERVED_ENGAGEMENTS_QUERY,
  PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
  ProductZkTlsRuleProgressOperationName,
  StartProductZkTlsProofOperationName,
  StartProductZkTlsTestProofOperationName,
  SubmitProductExperienceProofOperationName,
} from '../queries'

const PRODUCT_EXPERIENCE_DOCUMENT_SHA256 =
  'afa8256b861be2b084ac8976478a14bd716d50473c203ca87e62868cce720577'

const PRODUCT_EXPERIENCE_OPERATIONS = [
  {
    id: 'verify.product-experience.ticket.v1',
    operationName: MintProductExperienceTicketOperationName,
  },
  {
    id: 'verify.product-experience.test-ticket.v1',
    operationName: MintProductExperienceTestTicketOperationName,
  },
  {
    id: 'verify.product-experience.proof.v1',
    operationName: SubmitProductExperienceProofOperationName,
  },
  {
    id: 'verify.product-experience.zktls-start.v1',
    operationName: StartProductZkTlsProofOperationName,
  },
  {
    id: 'verify.product-experience.zktls-test-start.v1',
    operationName: StartProductZkTlsTestProofOperationName,
  },
  {
    id: 'verify.product-experience.zktls-progress.v1',
    operationName: ProductZkTlsRuleProgressOperationName,
  },
] as const

describe('PLUGIN_OPERATIONS', () => {
  it('contains exactly the approved 19 plugin operations', () => {
    expect(
      PLUGIN_OPERATIONS.map((operation) => operation.operationName),
    ).toEqual([
      'CreateExtensionPairing',
      'PollExtensionPairing',
      'Me',
      'AvailableEngagements',
      'MyReservedEngagements',
      'AvailableTweets',
      'LighthouseMembers',
      'RecordTweetDwell',
      'ReportEngagementCapture',
      'MintEngagementTicket',
      'SubmitEngagementProof',
      'PromoteTweet',
      'CreateAutoReinvestTask',
      'MintProductExperienceTicket',
      'MintProductExperienceTestTicket',
      'SubmitProductExperienceProof',
      'StartProductZkTlsProof',
      'StartProductZkTlsTestProof',
      'ProductZkTlsRuleProgress',
    ])
  })

  it('keeps every checked-in document hash in sync', async () => {
    for (const operation of PLUGIN_OPERATIONS) {
      await expect(sha256Hex(operation.document)).resolves.toBe(
        operation.documentSha256,
      )
      expect(
        getPluginOperationByDocument(
          operation.document,
          operation.operationName,
        )?.id,
      ).toBe(operation.id)
    }
  })

  it('versions the expanded engagement documents as v2 operations', () => {
    expect(PLUGIN_OPERATIONS.map((operation) => operation.id)).not.toContain(
      'engagement.available.v1',
    )
    expect(PLUGIN_OPERATIONS.map((operation) => operation.id)).not.toContain(
      'engagement.reserved.v1',
    )
    expect(
      getPluginOperationByDocument(
        AVAILABLE_ENGAGEMENTS_QUERY,
        'AvailableEngagements',
      )?.id,
    ).toBe('engagement.available.v2')
    expect(
      getPluginOperationByDocument(
        MY_RESERVED_ENGAGEMENTS_QUERY,
        'MyReservedEngagements',
      )?.id,
    ).toBe('engagement.reserved.v2')
  })

  it('does not match a document with an added field or alias', () => {
    expect(
      getPluginOperationByDocument(
        'query Me { viewer: me { id username } }',
        'Me',
      ),
    ).toBeUndefined()
  })

  it('matches all six operations sharing the product document', async () => {
    await expect(sha256Hex(PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT)).resolves.toBe(
      PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
    )

    for (const expected of PRODUCT_EXPERIENCE_OPERATIONS) {
      expect(
        getPluginOperationByDocument(
          PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
          expected.operationName,
        ),
      ).toMatchObject({
        ...expected,
        documentSha256: PRODUCT_EXPERIENCE_DOCUMENT_SHA256,
        permission: 'verify',
        version: 1,
      })
    }
  })

  it('rejects an unknown operation name for the product document', () => {
    expect(
      getPluginOperationByDocument(
        PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
        'SubmitProductExperienceProofTypo',
      ),
    ).toBeUndefined()
  })
})
