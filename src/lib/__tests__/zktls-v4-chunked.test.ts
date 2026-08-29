import { describe, expect, test } from 'vitest'
import { v4DechunkBody } from '../zktls/v4-chunked'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const INVALID = 'zkTLS V4 response is invalid.'

function dechunk(wire: string, maxWireBytes = encoder.encode(wire).length) {
  return decoder.decode(v4DechunkBody(encoder.encode(wire), maxWireBytes))
}

describe('V4 bounded chunked decoder', () => {
  test('decodes multiple chunks with exact wire limits and one final copy', () => {
    expect(dechunk('4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n')).toBe('Wikipedia')
    expect(dechunk('A\r\n0123456789\r\n0\r\n\r\n')).toBe('0123456789')
  })

  test.each([
    0,
    65_537,
    1.5,
    Number.NaN,
  ])('rejects invalid wire cap %s', (maxWireBytes) => {
    expect(() =>
      v4DechunkBody(encoder.encode('1\r\na\r\n0\r\n\r\n'), maxWireBytes),
    ).toThrow(INVALID)
  })

  test('rejects input one byte over the signed wire cap', () => {
    const wire = encoder.encode('1\r\na\r\n0\r\n\r\n')
    expect(() => v4DechunkBody(wire, wire.length - 1)).toThrow(INVALID)
  })

  test.each([
    ['', 'empty input'],
    ['0\r\n\r\n', 'zero-only body'],
    ['1;x=y\r\na\r\n0\r\n\r\n', 'extension'],
    ['1 \r\na\r\n0\r\n\r\n', 'whitespace'],
    ['+1\r\na\r\n0\r\n\r\n', 'sign'],
    ['0x1\r\na\r\n0\r\n\r\n', '0x prefix'],
    ['1\na\r\n0\r\n\r\n', 'LF-only size line'],
    ['1\r\na\n0\r\n\r\n', 'LF-only data terminator'],
    ['2\r\na', 'premature EOF'],
    ['1\r\na\r\n0\r\n', 'missing final CRLF'],
    ['1\r\na\r\n0\r\nX: y\r\n\r\n', 'trailer'],
    ['1\r\na\r\n0\r\n\r\nx', 'trailing bytes'],
    ['FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF\r\na\r\n0\r\n\r\n', 'size overflow'],
  ])('rejects malformed chunked framing: %s (%s)', (wire) => {
    expect(() => dechunk(wire)).toThrow(INVALID)
  })
})
