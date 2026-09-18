import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../env', () => ({
  API_ENDPOINT: 'https://service.lhdaobeta.top/graphql',
}))

import { gql } from '../gql'
import { pluginOperationIdFor } from '../plugin-signature'
import {
  ME_QUERY,
  type MeResult,
  MINT_PRODUCT_EXPERIENCE_TEST_TICKET_MUTATION,
  MINT_PRODUCT_EXPERIENCE_TICKET_MUTATION,
  RESERVE_TIMELINE_SLOT_MUTATION,
  SUBMIT_PRODUCT_EXPERIENCE_PROOF_MUTATION,
} from '../queries'

const PRIVATE_JWK: JsonWebKey = {
  kty: 'EC',
  x: 'RRkW-IilJGV1obxWUFjuV9WDdYnSWCL8HvYozQVkb-k',
  y: 'KDLbFMR8BLOocBojc769PKq7IWHnzCWSH_uEX0HFOjU',
  crv: 'P-256',
  d: 'FX9vTE5wCf1HecYJz9Io7_Q4R7B4aIgbKqrDlBLgMYA',
}

const PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  x: PRIVATE_JWK.x,
  y: PRIVATE_JWK.y,
  crv: 'P-256',
}

const DEVICE_ID = 'device-test-1'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]:
            key === 'apiToken'
              ? 'lhdao_pk_test'
              : key === 'deviceId'
                ? DEVICE_ID
                : key === 'devicePublicKeyJwk'
                  ? PUBLIC_JWK
                  : key === 'devicePrivateKeyJwk'
                    ? PRIVATE_JWK
                    : null,
        })),
        set: vi.fn(),
        remove: vi.fn(),
      },
    },
  })
})

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function verifySignature(headers: Record<string, string>) {
  const message = [
    'lhdao-plugin-v1',
    headers['x-plugin-operation-id'],
    await sha256Hex(ME_QUERY),
    await sha256Hex('{}'),
    DEVICE_ID,
    headers['x-request-timestamp'],
    headers['x-request-nonce'],
  ].join('\n')
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    PUBLIC_JWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const signature = Uint8Array.from(
    atob(toBase64(headers['x-device-signature'])),
    (char) => char.charCodeAt(0),
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    new TextEncoder().encode(message),
  )
}

function toBase64(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64 + '='.repeat((4 - (base64.length % 4)) % 4)
}

describe('gql plugin request signing', () => {
  it.each([
    [
      MINT_PRODUCT_EXPERIENCE_TICKET_MUTATION,
      'verify.product-experience.ticket.v1',
    ],
    [
      MINT_PRODUCT_EXPERIENCE_TEST_TICKET_MUTATION,
      'verify.product-experience.test-ticket.v1',
    ],
    [
      SUBMIT_PRODUCT_EXPERIENCE_PROOF_MUTATION,
      'verify.product-experience.proof.v1',
    ],
  ])('allows signing Product Experience operation %s', (query, operationId) => {
    expect(pluginOperationIdFor(query)).toBe(operationId)
  })

  it('signs ReserveTimelineEngagementSlot as engagement.reserve.v1', () => {
    expect(pluginOperationIdFor(RESERVE_TIMELINE_SLOT_MUTATION)).toBe(
      'engagement.reserve.v1',
    )
  })

  it('adds signed plugin security headers for token requests', async () => {
    let capturedHeaders: Record<string, string> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>
        return new Response(JSON.stringify({ data: { me: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    await gql<MeResult>(ME_QUERY)

    expect(capturedHeaders).toMatchObject({
      Authorization: 'Bearer lhdao_pk_test',
      'x-plugin-operation-id': 'user.me.v1',
      'x-device-id': DEVICE_ID,
    })
    expect(capturedHeaders?.['x-request-timestamp']).toMatch(/^\d+$/)
    expect(capturedHeaders?.['x-request-nonce']).toMatch(
      /^[A-Za-z0-9_-]{12,128}$/,
    )
    expect(capturedHeaders?.['x-device-signature']).toMatch(/^[A-Za-z0-9_-]+$/)
    await expect(verifySignature(capturedHeaders!)).resolves.toBe(true)
  })
})
