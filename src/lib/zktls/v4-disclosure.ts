import type { CapturedRequest } from './capture'
import type { V4Connector } from './interpreter'

export type DisclosureRange = Readonly<{ start: number; end: number }>

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

function fail(): never {
  throw new Error('request did not match the signed V4 connector')
}

function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '')
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  )
}

function requestBodyOffset(sent: Uint8Array): number {
  for (let at = 0; at <= sent.length - 4; at += 1) {
    if (
      sent[at] === 13 &&
      sent[at + 1] === 10 &&
      sent[at + 2] === 13 &&
      sent[at + 3] === 10
    )
      return at + 4
  }
  return fail()
}

function expectedAuthorities(origin: string): ReadonlySet<string> {
  const url = new URL(origin)
  const hostname = url.hostname.toLowerCase()
  return url.port === ''
    ? new Set([hostname, `${hostname}:443`])
    : new Set([`${hostname}:${url.port}`])
}

export function v4RequestDisclosureRanges(
  sent: Uint8Array,
  connector: V4Connector,
  captured: CapturedRequest,
): DisclosureRange[] {
  if (
    !(sent instanceof Uint8Array) ||
    sent.length === 0 ||
    sent.length > connector.request.max_sent_data ||
    sent.includes(0)
  )
    return fail()

  let text: string
  try {
    text = decoder.decode(sent)
  } catch {
    return fail()
  }
  const bodyOffset = requestBodyOffset(sent)
  const head = decoder.decode(sent.subarray(0, bodyOffset - 4))
  const lines = head.split('\r\n')
  if (
    lines.length < 2 ||
    lines.some((line) => line.includes('\r') || line.includes('\n')) ||
    lines[0] !== `${connector.request.method} ${captured.path} HTTP/1.1`
  )
    return fail()

  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (line.startsWith(' ') || line.startsWith('\t')) return fail()
    const colon = line.indexOf(':')
    const name = line.slice(0, colon)
    if (colon <= 0 || !HEADER_NAME.test(name)) return fail()
    const lowerName = name.toLowerCase()
    if (headers.has(lowerName)) return fail()
    const value = trimOws(line.slice(colon + 1))
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) return fail()
    }
    headers.set(lowerName, value)
  }

  const allowed =
    connector.request.method === 'GET'
      ? new Set(['host', 'connection'])
      : new Set(['host', 'connection', 'content-type', 'content-length'])
  if (
    headers.size !== allowed.size ||
    [...headers.keys()].some((name) => !allowed.has(name)) ||
    [...allowed].some((name) => !headers.has(name)) ||
    headers.get('connection') !== 'close' ||
    !expectedAuthorities(connector.origin).has(
      headers.get('host')!.toLowerCase(),
    )
  )
    return fail()

  const actualBody = sent.subarray(bodyOffset)
  if (connector.request.method === 'GET') {
    if (actualBody.length !== 0) return fail()
  } else {
    if (
      captured.method !== 'POST' ||
      captured.body === undefined ||
      captured.content_type !== 'application/json' ||
      connector.request.content_type !== 'application/json' ||
      headers.get('content-type') !== 'application/json'
    )
      return fail()
    const length = headers.get('content-length')!
    if (!DECIMAL.test(length) || Number(length) !== actualBody.length)
      return fail()
    if (!equal(actualBody, encoder.encode(captured.body))) return fail()
  }

  // Decoding the whole transcript above ensures there are no opaque bytes.
  if (encoder.encode(text).length !== sent.length) return fail()
  return [{ start: 0, end: sent.length }]
}
