import { describe, expect, test } from 'vitest'
import {
  htmlBetweenDisclosureRanges,
  interpretCaptured,
  jsonPathClaim,
  regexDisclosureRanges,
  validateConnector,
} from '@/lib/zktls/interpreter'

const request = {
  method: 'GET',
  matcher: {
    path: { kind: 'exact', value: '/viewer' },
    query: { required: {}, optional: {}, capture: {} },
    resource_types: ['fetch'],
  },
  headers: { accept: 'application/json' },
  secret_headers: ['cookie'],
  max_sent_data: 8192,
  max_recv_data: 65536,
  replay_safety_evidence: 'The viewer endpoint is read-only.',
} as const

const base = {
  interpreter_version: 3,
  connector_id: 'selector-test',
  revision: 1,
  disabled: false,
  expires_at: '2030-01-01T00:00:00.000Z',
  origin: 'https://github.com',
  request,
  response_status: 200,
  verifier_profile_id: 'lighthouse-v1',
} as const

describe('zkTLS v3 selectors', () => {
  test('independently extracts a bounded typed JSONPath scalar', () => {
    const config = validateConnector({
      ...base,
      response_format: 'json',
      extraction: {
        kind: 'json_path',
        path: '$.viewer.items[0]["login"]',
        value_type: 'string',
        max_bytes: 32,
      },
    })
    if (
      config.interpreter_version !== 3 ||
      config.extraction.kind !== 'json_path' ||
      config.response_format !== 'json'
    )
      throw new Error('wrong selector config')
    const response = '{"viewer":{"items":[{"login":"octocat"}]}}'
    expect(jsonPathClaim(config, response)).toBe('octocat')
    expect(
      interpretCaptured(config, {
        response,
        status: 200,
        now: '2026-08-17T00:00:00.000Z',
        request_target: '/viewer',
      }),
    ).toMatchObject({ claim: 'octocat' })
    expect(() =>
      jsonPathClaim(config, '{"viewer":{"items":[{"login":1}]}}'),
    ).toThrow('wrong type')
  })

  test('rejects wildcard, filter, script, and unsupported XPath selectors', () => {
    for (const path of [
      '$.viewer[*]',
      '$.viewer[?(@.login)]',
      '$.viewer..login',
    ]) {
      expect(() =>
        validateConnector({
          ...base,
          response_format: 'json',
          extraction: {
            kind: 'json_path',
            path,
            value_type: 'string',
            max_bytes: 32,
          },
        }),
      ).toThrow()
    }
    expect(() =>
      validateConnector({
        ...base,
        response_format: 'html',
        extraction: { kind: 'xpath', path: '//span', max_bytes: 32 },
      }),
    ).toThrow('unsupported')
  })

  test('reveals exactly one bounded regex capture', () => {
    const config = validateConnector({
      ...base,
      response_format: 'html',
      extraction: {
        kind: 'regex',
        pattern: 'data-user="([^"]+)"',
        max_bytes: 32,
      },
    })
    if (
      config.interpreter_version !== 3 ||
      config.extraction.kind !== 'regex' ||
      config.response_format !== 'html'
    )
      throw new Error('wrong selector config')
    expect(
      regexDisclosureRanges(config, '<span data-user="octocat"></span>'),
    ).toMatchObject({ claim: 'octocat' })
    expect(() =>
      regexDisclosureRanges(
        config,
        '<span data-user="octocat"></span><span data-user="hubot"></span>',
      ),
    ).toThrow('ambiguous')
    expect(() =>
      regexDisclosureRanges(
        config,
        '<span data-user="a-very-long-login"></span>',
      ),
    ).not.toThrow()
    expect(() =>
      validateConnector({
        ...base,
        response_format: 'html',
        extraction: {
          kind: 'regex',
          pattern: '(data-user)="([^"]+)"',
          max_bytes: 32,
        },
      }),
    ).toThrow('one capture group')
    expect(() =>
      validateConnector({
        ...base,
        response_format: 'html',
        extraction: {
          kind: 'regex',
          pattern: `(${'.'.repeat(256)})`,
          max_bytes: 32,
        },
      }),
    ).toThrow('bounded string')
  })

  test('reveals one JSON regex scalar and rejects duplicate matches', () => {
    const config = validateConnector({
      ...base,
      response_format: 'json',
      extraction: {
        kind: 'regex',
        pattern: '"volume":(\\d+)',
        max_bytes: 32,
      },
    })
    if (config.interpreter_version !== 3 || config.extraction.kind !== 'regex')
      throw new Error('wrong selector config')
    expect(regexDisclosureRanges(config, '{"volume":7200}')).toMatchObject({
      claim: '7200',
    })
    expect(() =>
      regexDisclosureRanges(config, '{"volume":7200,"volume":7300}'),
    ).toThrow('ambiguous')
  })

  test('accepts generated Product regex and rejects dynamic outer context', () => {
    for (const pattern of [
      '"volume"\\s*:\\s*(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)',
      '^balance: ([0-9]{1,8})$',
      '^(?:foo)+(bar)$',
      '(?:^|\\n)(From: [^\\r\\n]+)',
    ]) {
      expect(() =>
        validateConnector({
          ...base,
          response_format: 'json',
          extraction: { kind: 'regex', pattern, max_bytes: 32 },
        }),
      ).not.toThrow()
    }
    for (const pattern of ['^.*"volume":(\\d+)$', '^.*"volume":(\\d+).*$'])
      expect(() =>
        validateConnector({
          ...base,
          response_format: 'json',
          extraction: {
            kind: 'regex',
            pattern,
            max_bytes: 32,
          },
        }),
      ).toThrow('fixed context')
  })

  test('enforces regex result size and retains html_between behavior', () => {
    const regex = validateConnector({
      ...base,
      response_format: 'html',
      extraction: {
        kind: 'regex',
        pattern: 'data-user="([^"]+)"',
        max_bytes: 3,
      },
    })
    if (
      regex.interpreter_version !== 3 ||
      regex.extraction.kind !== 'regex' ||
      regex.response_format !== 'html'
    )
      throw new Error('wrong selector config')
    expect(() =>
      regexDisclosureRanges(regex, '<span data-user="octocat"></span>'),
    ).toThrow('exceeds its limit')

    const html = validateConnector({
      ...base,
      response_format: 'html',
      extraction: {
        kind: 'html_between',
        prefix: '<span data-user="',
        suffix: '"></span>',
        max_bytes: 32,
      },
    })
    if (
      html.interpreter_version !== 3 ||
      html.extraction.kind !== 'html_between' ||
      html.response_format !== 'html'
    )
      throw new Error('wrong selector config')
    expect(
      htmlBetweenDisclosureRanges(html, '<span data-user="octocat"></span>'),
    ).toMatchObject({ claim: 'octocat' })
  })
})
