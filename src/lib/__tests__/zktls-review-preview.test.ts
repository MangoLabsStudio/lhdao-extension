import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { V4Connector } from '../zktls/interpreter'
import { evaluateProductZkTlsPipeline } from '../zktls/preview-pipeline'
import { buildProofReviewSnapshot } from '../zktls/review-preview'

const wallet = '0x1111111111111111111111111111111111111111'
const other = '0x2222222222222222222222222222222222222222'
const fixture = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-field-difference.json', 'utf8'),
)

function connector(): V4Connector {
  return {
    ...structuredClone(fixture.connector),
    purpose: 'ACCOUNT_BINDING',
    account_binding: {
      providerKey: 'example',
      accountVariable: 'accountId',
      walletOutput: 'walletAddress',
      addressType: 'EVM',
    },
    variables: [
      {
        name: 'accountId',
        scalarType: 'STRING',
        source: {
          kind: 'CAPTURED_REQUEST',
          location: 'QUERY',
          selector: 'account',
        },
      },
    ],
    resolved_variables: {},
    pipelines: [
      {
        output: 'walletAddress',
        sourcePath: '$.accounts[*]',
        valuePath: '$.address',
        cast: 'STRING',
        reduce: 'UNIQUE',
        filter: { op: 'EQ', path: '$.account', value: { $var: 'accountId' } },
      },
    ],
  }
}

function input() {
  return {
    connector: connector(),
    captured: {
      path: '/v1/events?account=subaccount-a',
      secrets: {},
      capturedVariables: { accountId: 'subaccount-a' },
    },
    response: {
      text: JSON.stringify({
        accounts: [{ account: 'subaccount-a', address: wallet }],
      }),
      contentType: 'application/json',
      status: 200,
    },
    expectedWallet: wallet,
    pageUrl: 'https://app.example.com/history',
    id: 'review-1',
    title: 'Account review',
    expiresAt: Date.now() + 60_000,
  }
}

describe('local proof review snapshot', () => {
  it('redacts request-cookie and response-cookie echoes before returning the preview', () => {
    const args = input()
    args.response.text = JSON.stringify({
      accounts: [{ account: 'subaccount-a', address: wallet }],
      echo: 'cookie-only-secret',
      other: 'response-cookie-secret',
    })
    const snapshot = buildProofReviewSnapshot({
      ...args,
      requestHeaders: { Cookie: 'session=cookie-only-secret' },
      response: {
        ...args.response,
        headers: { 'set-cookie': 'session=response-cookie-secret; HttpOnly' },
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain('cookie-only-secret')
    expect(JSON.stringify(snapshot)).not.toContain('response-cookie-secret')
  })
  it('preserves the extension-generated review nonce for one-time confirmation', () => {
    const id = '610adfef-5b09-4574-8562-0d81bf2957ee'
    expect(buildProofReviewSnapshot({ ...input(), id }).id).toBe(id)
  })
  it('separates captured account identity from wallet matched through the signed pipeline', () => {
    expect(buildProofReviewSnapshot(input())).toMatchObject({
      requestAccounts: [{ name: 'accountId', value: 'subaccount-a' }],
      account: {
        observed: wallet,
        expected: wallet,
        status: 'matched',
        source: 'response',
      },
      canConfirm: true,
      error: null,
      responseState: 'json',
    })
  })

  it.each([
    other,
    null,
  ])('blocks mismatching or unavailable backend wallet %s', (expectedWallet) => {
    expect(
      buildProofReviewSnapshot({ ...input(), expectedWallet }),
    ).toMatchObject({ canConfirm: false })
  })

  it('rejects ambiguous wallets after applying the signed account filter', () => {
    const args = input()
    args.response.text = JSON.stringify({
      accounts: [
        { account: 'subaccount-a', address: wallet },
        { account: 'subaccount-a', address: other },
      ],
    })
    const result = buildProofReviewSnapshot(args)
    expect(result.canConfirm).toBe(false)
    expect(result.error).toContain('AMBIGUOUS')
    expect(result.values).toEqual([])
  })

  it('uses generic signed bytes32 conversion', () => {
    const args = input()
    args.connector.pipelines[0].cast = 'EVM_ADDRESS_FROM_BYTES32_PREFIX'
    args.response.text = JSON.stringify({
      accounts: [
        { account: 'subaccount-a', address: `${wallet}${'0'.repeat(24)}` },
      ],
    })
    expect(buildProofReviewSnapshot(args).account.observed).toBe(wallet)
  })

  it('preserves subaccount business identifiers for signed wallet extraction', () => {
    const args = input()
    const subaccount = `${wallet}64656661756c740000000000`
    args.connector.pipelines[0].valuePath = '$.subaccount'
    args.connector.pipelines[0].cast = 'EVM_ADDRESS_FROM_BYTES32_PREFIX'
    args.response.text = JSON.stringify({
      accounts: [{ account: 'subaccount-a', subaccount }],
    })
    expect(buildProofReviewSnapshot(args)).toMatchObject({
      response: { accounts: [{ subaccount }] },
      account: { observed: wallet, status: 'matched' },
      canConfirm: true,
      error: null,
    })
  })

  it.each([
    'wallet-1',
    'owner-result',
  ])('uses signed wallet semantics for output %s', (output) => {
    const args = input()
    args.connector.account_binding!.walletOutput = output
    args.connector.pipelines[0].output = output
    expect(buildProofReviewSnapshot(args)).toMatchObject({
      account: { observed: wallet, status: 'matched' },
      values: [{ output, value: wallet }],
      canConfirm: true,
      error: null,
    })
  })

  it.each([
    'token',
    'subaccount_token',
  ])('still hides a credential field named %s', (field) => {
    const args = input()
    const secret = `${wallet}64656661756c740000000000`
    args.connector.pipelines[0].valuePath = `$.${field}`
    args.connector.pipelines[0].cast = 'EVM_ADDRESS_FROM_BYTES32_PREFIX'
    args.response.text = JSON.stringify({
      accounts: [
        { account: 'subaccount-a', [field]: secret, subaccount: secret },
      ],
    })
    const snapshot = buildProofReviewSnapshot(args)
    expect(snapshot.canConfirm).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })

  it('does not exempt a sensitive wallet output name', () => {
    const args = input()
    args.connector.account_binding!.walletOutput = 'accessToken'
    args.connector.pipelines[0].output = 'accessToken'
    expect(buildProofReviewSnapshot(args)).toMatchObject({
      canConfirm: false,
      values: [],
      error: 'PRODUCT_ZKTLS_REVIEW_REDACTED',
    })
  })

  it('labels METRIC identity as verified binding without inventing a response wallet', () => {
    const args = input()
    args.connector = structuredClone(fixture.connector)
    args.response.text = Buffer.from(
      fixture.decodedBase64url,
      'base64url',
    ).toString('utf8')
    const result = buildProofReviewSnapshot(args)
    expect(result).toMatchObject({
      canConfirm: true,
      account: {
        observed: wallet,
        expected: wallet,
        status: 'matched',
        source: 'verified-binding',
      },
      values: [
        {
          output: fixture.pipeline.output,
          value: fixture.expected.value,
          unit: fixture.expected.unit,
        },
      ],
    })
    args.connector.resolved_variables = {}
    expect(buildProofReviewSnapshot(args).canConfirm).toBe(false)
  })

  it.each([
    [undefined, 'unavailable'],
    ['', 'empty'],
    ['<html>login</html>', 'non-json'],
    ['{"accounts":', 'invalid'],
    ['x'.repeat(65_537), 'oversize'],
    ['{"accounts":[]}', 'empty'],
  ] as const)('disables confirmation for %s (%s)', (text, state) => {
    const args = input()
    const result = buildProofReviewSnapshot({
      ...args,
      response: { ...args.response, text },
    })
    expect(result).toMatchObject({
      responseState: state,
      canConfirm: false,
      values: [],
    })
    expect(result.error).toBeTruthy()
  })

  it('fails visibly on HTTP errors, expired snapshots, and wrong-page origins', () => {
    const args = input()
    for (const variation of [
      { ...args, response: { ...args.response, status: 403 } },
      { ...args, expiresAt: 1 },
      { ...args, pageUrl: 'https://other.example/history' },
    ])
      expect(buildProofReviewSnapshot(variation).canConfirm).toBe(false)
  })

  it('hides credentials and echoes from every snapshot field', () => {
    const args = input()
    const secret = 'session-private-123'
    args.captured.secrets = { authorization: `Bearer ${secret}` }
    args.captured.path += `&token=${secret}`
    args.response.text = JSON.stringify({
      accounts: [{ account: 'subaccount-a', address: wallet }],
      token: secret,
      echo: secret,
    })
    const result = buildProofReviewSnapshot(args)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('Bearer')
    expect(result.canConfirm).toBe(true)
  })

  it('does not disclose credential-derived outputs or treat missing amounts as zero', () => {
    const args = input()
    args.connector.pipelines.push({
      output: 'amount',
      sourcePath: '$.token',
      cast: 'STRING',
    })
    args.response.text = JSON.stringify({
      accounts: [{ account: 'subaccount-a', address: wallet }],
      token: 'private',
    })
    expect(buildProofReviewSnapshot(args)).toMatchObject({
      canConfirm: false,
      values: [],
    })
  })
})

describe('frontend pipeline fixture parity', () => {
  it('preserves signed time window, fixed decimals, absolute values, grouping and count', () => {
    const window = JSON.parse(
      readFileSync('test/fixtures/product-zktls-v4-window.json', 'utf8'),
    )
    expect(
      evaluateProductZkTlsPipeline(
        window.connector.pipelines[0],
        JSON.parse(
          Buffer.from(window.decodedBase64url, 'base64url').toString('utf8'),
        ),
        window.connector.resolved_variables,
      ),
    ).toEqual({
      type: 'number',
      value: window.expected.qualifyingDays,
      unit: window.expected.unit,
    })
  })

  it('preserves exact 18 decimal field-difference precision', () => {
    expect(
      evaluateProductZkTlsPipeline(
        fixture.pipeline,
        JSON.parse(
          Buffer.from(fixture.decodedBase64url, 'base64url').toString('utf8'),
        ),
        {},
      ),
    ).toEqual({
      type: 'number',
      value: fixture.expected.value,
      unit: fixture.expected.unit,
    })
  })

  it('preserves the same bytes32-prefix fixture', () => {
    const prefix = JSON.parse(
      readFileSync('test/fixtures/product-zktls-v4-evm-prefix.json', 'utf8'),
    )
    expect(
      evaluateProductZkTlsPipeline(
        {
          output: 'wallet',
          sourcePath: '$.account',
          cast: 'EVM_ADDRESS_FROM_BYTES32_PREFIX',
        },
        { account: prefix.sourceAccount },
        {},
      ),
    ).toEqual({ type: 'string', value: prefix.expectedWallet })
  })

  it('rejects fractional JS numbers instead of silently rounding', () => {
    expect(() =>
      evaluateProductZkTlsPipeline(
        { output: 'amount', sourcePath: '$.amount', cast: 'DECIMAL' },
        { amount: 1.1 },
        {},
      ),
    ).toThrow()
  })
})
