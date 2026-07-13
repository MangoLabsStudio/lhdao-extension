import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../canonical-json'
import {
  getPluginOperationByDocument,
  PLUGIN_OPERATIONS,
} from '../plugin-operations'

describe('PLUGIN_OPERATIONS', () => {
  it('contains exactly the approved 13 plugin operations', () => {
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
    ])
  })

  it('keeps every checked-in document hash in sync', async () => {
    for (const operation of PLUGIN_OPERATIONS) {
      await expect(sha256Hex(operation.document)).resolves.toBe(
        operation.documentSha256,
      )
      expect(getPluginOperationByDocument(operation.document)?.id).toBe(
        operation.id,
      )
    }
  })

  it('does not match a document with an added field or alias', () => {
    expect(
      getPluginOperationByDocument('query Me { viewer: me { id username } }'),
    ).toBeUndefined()
  })
})
