import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '../canonical-json'
import { getPluginOperationByDocument } from '../plugin-operations'
import {
  PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
  PROMOTE_TWEET_MUTATION,
  type PreviewPromoteTweetPricingVars,
  type PromoteTweetVars,
} from '../queries'
import { signPluginRequest } from '../request-signing'
import { releaseSpendActionKey, spendActionKey } from '../spend-idempotency'

const PRIVATE_JWK: JsonWebKey = {
  kty: 'EC',
  x: 'RRkW-IilJGV1obxWUFjuV9WDdYnSWCL8HvYozQVkb-k',
  y: 'KDLbFMR8BLOocBojc769PKq7IWHnzCWSH_uEX0HFOjU',
  crv: 'P-256',
  d: 'FX9vTE5wCf1HecYJz9Io7_Q4R7B4aIgbKqrDlBLgMYA',
}

const variables: PromoteTweetVars = {
  input: {
    quoteId: 'quote-plugin-1',
    tweetUrl: 'https://x.com/lighthouse/status/1',
    actions: [{ actionType: 'LIKE', tierSlots: { A: 5 } }],
    lighthouseSelectedOnly: false,
  },
}

describe('quoted promote operation signatures', () => {
  it('allowlists the frozen pricing query as a v2 signed read', async () => {
    expect(await sha256Hex(PREVIEW_PROMOTE_TWEET_PRICING_QUERY)).toBe(
      'd71bdd5a31703929fc61a7408b167668f558c16840c340ce8073248b8190e934',
    )
    expect(
      getPluginOperationByDocument(
        PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
        'PreviewPromoteTweetPricing',
      ),
    ).toMatchObject({
      id: 'read.promote-pricing.v2',
      permission: 'read',
    })

    const privateKey = await crypto.subtle.importKey(
      'jwk',
      PRIVATE_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    const previewVariables: PreviewPromoteTweetPricingVars = {
      input: {
        tweetUrl: variables.input.tweetUrl,
        actions: variables.input.actions,
      },
    }
    const signed = await signPluginRequest({
      operation: getPluginOperationByDocument(
        PREVIEW_PROMOTE_TWEET_PRICING_QUERY,
        'PreviewPromoteTweetPricing',
      )!,
      variables: previewVariables,
      deviceId: 'device-test-1',
      privateKey,
      timestamp: '1783944000000',
      nonce: 'nonce-test-123456',
    })
    expect(signed.headers).toMatchObject({
      'x-plugin-operation-id': 'read.promote-pricing.v2',
      'x-device-id': 'device-test-1',
    })
  })

  it('binds the unchanged quoteId into the signed spend variables', async () => {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      PRIVATE_JWK,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    const operation = getPluginOperationByDocument(
      PROMOTE_TWEET_MUTATION,
      'PromoteTweet',
    )!
    const signed = await signPluginRequest({
      operation,
      variables,
      deviceId: 'device-test-1',
      privateKey,
      timestamp: '1783944000000',
      nonce: 'nonce-test-123456',
    })

    expect(operation.id).toBe('spend.promote.v1')
    expect(signed.headers).toMatchObject({
      'x-plugin-operation-id': 'spend.promote.v1',
      'x-device-id': 'device-test-1',
    })
    expect(signed.message).toContain(await sha256Hex(canonicalJson(variables)))
    expect(signed.message).not.toContain(
      await sha256Hex(
        canonicalJson({ input: { ...variables.input, quoteId: undefined } }),
      ),
    )
  })

  it('reuses the existing idempotency key for an exact quoted retry', () => {
    const first = spendActionKey('promote', variables)
    expect(spendActionKey('promote', structuredClone(variables))).toBe(first)
    expect(
      spendActionKey('promote', {
        input: { ...variables.input, quoteId: 'quote-plugin-2' },
      }),
    ).not.toBe(first)
    releaseSpendActionKey('promote', variables)
    releaseSpendActionKey('promote', {
      input: { ...variables.input, quoteId: 'quote-plugin-2' },
    })
  })

  it('keeps the plugin parity fixture byte-identical to the Web fixture', async () => {
    const fixture = readFileSync(
      resolve(
        process.cwd(),
        'src/lib/__tests__/fixtures/engagement-pilot-channel-parity.json',
      ),
      'utf8',
    )
    expect(await sha256Hex(fixture)).toBe(
      '80e8bebc7816223bddc21583bd00d9824229ef202a3ad74154f66aa8d9d220e4',
    )
  })

  it('contains no local price table, fee rate, or total calculation', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/promote/PromoteDialog.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(/const PRICE|FEE_RATE|actionCost/u)
    expect(source).not.toMatch(/totalCost\s*=|unitPrice\s*\*/u)
  })

  it('contains no public future-price fields in buyer production sources', () => {
    const source = [
      'src/lib/queries.ts',
      'src/lib/plugin-operations.ts',
      'src/types/messages.ts',
      'src/entrypoints/background.ts',
      'src/components/promote/PromoteDialog.tsx',
    ]
      .map((path) => readFileSync(resolve(process.cwd(), path), 'utf8'))
      .join('\n')

    expect(source).not.toMatch(/todayPrice|tomorrowExpectedPrice/u)
    expect(source).not.toMatch(/明日预计|价格日程/u)
  })
})
