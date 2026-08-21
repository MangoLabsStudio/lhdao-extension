import { describe, expect, test } from 'vitest'
import type {
  V4ResolvedVariable,
  V4TemplateValue,
  V4VariableDeclaration,
} from '@/lib/zktls/interpreter'
import { matchV4Body, v4SemanticDigest } from '@/lib/zktls/v4-template'

const captured = (
  name: string,
  scalarType: V4VariableDeclaration['scalarType'] = 'STRING',
  location: 'BODY_JSON' | 'BODY_FORM' = 'BODY_JSON',
  selector = '$.params.account',
): V4VariableDeclaration => ({
  name,
  scalarType,
  source: { kind: 'CAPTURED_REQUEST', location, selector },
})

describe('zkTLS V4 request body templates', () => {
  test('matches nested JSON, captures a typed variable, and preserves exact bytes', async () => {
    const exactBody =
      '{ "type": "subaccounts", "params": { "account": "acct-1", "tags": ["a", "b"] } }'
    const template: V4TemplateValue = {
      type: 'subaccounts',
      params: { account: { $var: 'accountId' }, tags: ['a', 'b'] },
    }

    const match = matchV4Body(
      new TextEncoder().encode(exactBody),
      'application/json',
      template,
      {},
      [captured('accountId')],
    )
    expect(match).toEqual({
      exactBody,
      semanticCanonical:
        '{"params":{"account":"acct-1","tags":["a","b"]},"type":"subaccounts"}',
      captured: { accountId: 'acct-1' },
    })
    await expect(v4SemanticDigest(match!.semanticCanonical)).resolves.toBe(
      '4979bc637a84aafe2c3863df7b090d5ace6615e009071222c8a73c3295c9d2dd',
    )
  })

  test('matches exact and allow-extra objects without weakening arrays', () => {
    const resolved: Record<string, V4ResolvedVariable> = {
      day: { type: 'STRING', value: '2026-08-21' },
    }
    const allowExtra: V4TemplateValue = {
      $object: {
        mode: 'ALLOW_EXTRA',
        fields: { day: { $var: 'day' }, values: [1, true, null] },
      },
    }
    expect(
      matchV4Body(
        new TextEncoder().encode(
          '{"day":"2026-08-21","values":[1,true,null],"trace":"ok"}',
        ),
        'application/json',
        allowExtra,
        resolved,
      ),
    ).not.toBeNull()
    expect(
      matchV4Body(
        new TextEncoder().encode(
          '{"day":"2026-08-21","values":[1,true],"trace":"ok"}',
        ),
        'application/json',
        allowExtra,
        resolved,
      ),
    ).toBeNull()
    expect(
      matchV4Body(
        new TextEncoder().encode('{"day":"2026-08-21","extra":true}'),
        'application/json',
        { day: { $var: 'day' } },
        resolved,
      ),
    ).toBeNull()
  })

  test.each([
    ['STRING', 'acct-1'],
    ['DECIMAL', '12.50'],
    ['INTEGER', '-7'],
    ['BOOLEAN', true],
    ['UTC_TIMESTAMP', '2026-08-21T00:00:00.000Z'],
  ] as const)('captures a %s scalar without coercion', (scalarType, value) => {
    const body = JSON.stringify({ value })
    expect(
      matchV4Body(
        new TextEncoder().encode(body),
        'application/json',
        { value: { $var: 'captured' } },
        {},
        [captured('captured', scalarType, 'BODY_JSON', '$.value')],
      )?.captured,
    ).toEqual({ captured: value })
  })

  test('matches form fixed arrays and rejects undeclared duplicate keys', () => {
    const template: V4TemplateValue = {
      account: { $var: 'accountId' },
      day: '2026 08 21',
      tags: ['one', 'two'],
    }
    const declaration = captured('accountId', 'STRING', 'BODY_FORM', 'account')
    const exactBody = 'day=2026+08+21&account=acct%2D1&tags=one&tags=two'
    expect(
      matchV4Body(
        new TextEncoder().encode(exactBody),
        'application/x-www-form-urlencoded',
        template,
        {},
        [declaration],
      ),
    ).toMatchObject({ exactBody, captured: { accountId: 'acct-1' } })
    expect(
      matchV4Body(
        new TextEncoder().encode(
          'day=2026+08+21&account=acct-1&account=acct-1&tags=one&tags=two',
        ),
        'application/x-www-form-urlencoded',
        template,
        {},
        [declaration],
      ),
    ).toBeNull()
  })

  test.each([
    '{"value":1,"value":1}',
    '{"value":1,"\\u0076alue":1}',
    '{"value":1.0}',
    '{"value":1e0}',
    '{"__proto__":"x"}',
    '{"constructor":"x"}',
  ])('fails closed for unsafe JSON: %s', (body) => {
    expect(() =>
      matchV4Body(
        new TextEncoder().encode(body),
        'application/json',
        { value: 1 },
        {},
      ),
    ).toThrow('captured JSON body is invalid')
  })

  test('rejects malformed UTF-8 and an 8,193-byte body', () => {
    expect(() =>
      matchV4Body(Uint8Array.of(0xc3, 0x28), 'application/json', null, {}),
    ).toThrow('UTF-8')
    expect(() =>
      matchV4Body(
        new Uint8Array(8193).fill(0x20),
        'application/json',
        null,
        {},
      ),
    ).toThrow('limit')
  })

  test('enforces captured variable constraints and canonical scalar forms', () => {
    const constrained = {
      ...captured('accountId'),
      constraints: {
        minLength: 3,
        maxLength: 8,
        pattern: 'ACCOUNT_ID' as const,
      },
    }
    expect(() =>
      matchV4Body(
        new TextEncoder().encode('{"account":"bad value"}'),
        'application/json',
        { account: { $var: 'accountId' } },
        {},
        [constrained],
      ),
    ).toThrow('variable is invalid')
    expect(() =>
      matchV4Body(
        new TextEncoder().encode('{"value":"01"}'),
        'application/json',
        { value: { $var: 'value' } },
        {},
        [captured('value', 'INTEGER', 'BODY_JSON', '$.value')],
      ),
    ).toThrow('variable is invalid')
    expect(() =>
      matchV4Body(
        new TextEncoder().encode('{"value":"2026-02-30T00:00:00Z"}'),
        'application/json',
        { value: { $var: 'value' } },
        {},
        [captured('value', 'UTC_TIMESTAMP', 'BODY_JSON', '$.value')],
      ),
    ).toThrow('variable is invalid')
  })

  test.each([
    'a=%',
    'a=%GG',
    'a=b=c',
    '__proto__=value',
  ])('rejects an unsafe form body: %s', (body) => {
    expect(() =>
      matchV4Body(
        new TextEncoder().encode(body),
        'application/x-www-form-urlencoded',
        { a: 'value' },
        {},
      ),
    ).toThrow('captured form body is invalid')
  })
})
