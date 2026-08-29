import type { CapturedRequest } from './capture'
import type { V4Connector } from './interpreter'
import { v4DechunkBody } from './v4-chunked'
import { v4GunzipJson } from './v4-gzip'

export type DisclosureRange = Readonly<{ start: number; end: number }>

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const MAX_HEADER_LINE = 8192
const MAX_HEADERS = 100
const MAX_JSON_DEPTH = 12
const MAX_JSON_NODES = 4096
const MAX_JSON_ELEMENTS = 200
const MAX_V4_RESPONSE_BYTES = 65_536
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

type V4PublicRequestInput = Readonly<{
  origin: string
  method: 'GET' | 'POST'
  path: string
  body?: string
  contentType?: string
  contentEncoding?: 'gzip'
}>

export type V4PublicRequestDetails = Readonly<{
  host: string
  body: Uint8Array | undefined
  sentByteLength: number
  contentEncoding?: 'gzip'
}>

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

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    return fail()
  }
}

function responseBody(
  received: Uint8Array,
  connector: V4Connector,
): Uint8Array {
  const lines: Uint8Array[] = []
  let offset = 0
  let bodyOffset = -1
  while (offset <= received.length) {
    let end = -1
    for (let at = offset; at < received.length - 1; at += 1) {
      if (received[at] === 13 && received[at + 1] === 10) {
        end = at
        break
      }
    }
    if (end < 0 || end - offset > MAX_HEADER_LINE) return fail()
    const line = received.subarray(offset, end)
    if (line.includes(10) || line.includes(13)) return fail()
    offset = end + 2
    if (line.length === 0) {
      bodyOffset = offset
      break
    }
    lines.push(line)
    if (lines.length > MAX_HEADERS + 1) return fail()
  }
  if (bodyOffset < 0 || lines.length === 0) return fail()
  if (!/^HTTP\/1\.[01] 200(?: [\x20-\x7e]*)?$/.test(decode(lines[0]!)))
    return fail()

  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    if (line[0] === 0x20 || line[0] === 0x09) return fail()
    const colon = line.indexOf(0x3a)
    if (colon <= 0) return fail()
    const name = decode(line.subarray(0, colon))
    if (!HEADER_NAME.test(name)) return fail()
    const lowerName = name.toLowerCase()
    if (headers.has(lowerName)) return fail()
    const value = trimOws(decode(line.subarray(colon + 1)))
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index)
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) return fail()
    }
    headers.set(lowerName, value)
  }
  if (
    headers.get('content-type') !== 'application/json' ||
    (connector.response_content_encoding === 'gzip'
      ? headers.get('content-encoding') !== 'gzip'
      : headers.has('content-encoding'))
  )
    return fail()
  const length = headers.get('content-length')
  const body = received.subarray(bodyOffset)
  if (connector.response_transfer_encoding === 'chunked') {
    if (headers.get('transfer-encoding') !== 'chunked' || length !== undefined)
      return fail()
    return v4DechunkBody(body, connector.request.max_recv_data)
  }
  if (
    headers.has('transfer-encoding') ||
    length === undefined ||
    !DECIMAL.test(length) ||
    !Number.isSafeInteger(Number(length)) ||
    Number(length) !== body.length
  )
    return fail()
  return body
}

class StrictResponseJsonParser {
  private offset = 0
  private nodes = 0

  constructor(private readonly bytes: Uint8Array) {}

  parse(): void {
    if (
      this.bytes[0] === 0xef &&
      this.bytes[1] === 0xbb &&
      this.bytes[2] === 0xbf
    )
      fail()
    this.space()
    this.value(1)
    this.space()
    if (this.offset !== this.bytes.length) fail()
  }

  private node(depth: number): void {
    this.nodes += 1
    if (depth > MAX_JSON_DEPTH || this.nodes > MAX_JSON_NODES) fail()
  }

  private space(): void {
    while (
      this.bytes[this.offset] === 0x20 ||
      this.bytes[this.offset] === 0x09 ||
      this.bytes[this.offset] === 0x0a ||
      this.bytes[this.offset] === 0x0d
    )
      this.offset += 1
  }

  private expect(byte: number): void {
    if (this.bytes[this.offset] !== byte) fail()
    this.offset += 1
  }

  private value(depth: number): void {
    this.node(depth)
    const byte = this.bytes[this.offset]
    if (byte === 0x7b) {
      this.object(depth)
      return
    }
    if (byte === 0x5b) {
      this.array(depth)
      return
    }
    if (byte === 0x22) {
      this.string()
      return
    }
    if (byte === 0x74) {
      this.literal('true')
      return
    }
    if (byte === 0x66) {
      this.literal('false')
      return
    }
    if (byte === 0x6e) {
      this.literal('null')
      return
    }
    this.number()
  }

  private object(depth: number): void {
    this.expect(0x7b)
    const keys = new Set<string>()
    this.space()
    if (this.bytes[this.offset] === 0x7d) {
      this.offset += 1
      return
    }
    while (true) {
      if (this.bytes[this.offset] !== 0x22) fail()
      const key = this.string()
      if (keys.has(key) || PROTOTYPE_KEYS.has(key)) fail()
      keys.add(key)
      this.space()
      this.expect(0x3a)
      this.space()
      this.value(depth + 1)
      this.space()
      if (this.bytes[this.offset] === 0x7d) {
        this.offset += 1
        return
      }
      this.expect(0x2c)
      this.space()
    }
  }

  private array(depth: number): void {
    this.expect(0x5b)
    let elements = 0
    this.space()
    if (this.bytes[this.offset] === 0x5d) {
      this.offset += 1
      return
    }
    while (true) {
      if (elements >= MAX_JSON_ELEMENTS) fail()
      elements += 1
      this.value(depth + 1)
      this.space()
      if (this.bytes[this.offset] === 0x5d) {
        this.offset += 1
        return
      }
      this.expect(0x2c)
      this.space()
    }
  }

  private string(): string {
    this.expect(0x22)
    let chunkStart = this.offset
    let value = ''
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset]
      if (byte === 0x22) {
        value += decode(this.bytes.subarray(chunkStart, this.offset))
        this.offset += 1
        return value
      }
      if (byte === 0x5c) {
        value += decode(this.bytes.subarray(chunkStart, this.offset))
        this.offset += 1
        const escaped = this.bytes[this.offset]
        if (escaped === 0x75) {
          const first = this.unicodeEscape()
          if (first >= 0xd800 && first <= 0xdbff) {
            if (
              this.bytes[this.offset] !== 0x5c ||
              this.bytes[this.offset + 1] !== 0x75
            )
              return fail()
            this.offset += 1
            const second = this.unicodeEscape()
            if (second < 0xdc00 || second > 0xdfff) return fail()
            value += String.fromCodePoint(
              0x10000 + ((first - 0xd800) << 10) + second - 0xdc00,
            )
          } else if (first >= 0xdc00 && first <= 0xdfff) return fail()
          else value += String.fromCharCode(first)
        } else {
          const mapped = new Map<number, string>([
            [0x22, '"'],
            [0x5c, '\\'],
            [0x2f, '/'],
            [0x62, '\b'],
            [0x66, '\f'],
            [0x6e, '\n'],
            [0x72, '\r'],
            [0x74, '\t'],
          ]).get(escaped!)
          if (mapped === undefined) return fail()
          value += mapped
          this.offset += 1
        }
        chunkStart = this.offset
        continue
      }
      if (byte === undefined || byte < 0x20) return fail()
      this.offset += 1
    }
    return fail()
  }

  private unicodeEscape(): number {
    this.offset += 1
    const end = this.offset + 4
    if (end > this.bytes.length) return fail()
    const value = decode(this.bytes.subarray(this.offset, end))
    if (!/^[0-9A-Fa-f]{4}$/.test(value)) return fail()
    this.offset = end
    return Number.parseInt(value, 16)
  }

  private literal(value: string): void {
    const expected = encoder.encode(value)
    if (
      !equal(
        this.bytes.subarray(this.offset, this.offset + expected.length),
        expected,
      )
    )
      fail()
    this.offset += expected.length
  }

  private number(): void {
    const start = this.offset
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset]!
      if (
        (byte >= 0x30 && byte <= 0x39) ||
        byte === 0x2d ||
        byte === 0x2b ||
        byte === 0x2e ||
        byte === 0x45 ||
        byte === 0x65
      )
        this.offset += 1
      else break
    }
    const value = decode(this.bytes.subarray(start, this.offset))
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value))
      fail()
  }
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

export function v4PublicRequestDetails(
  input: V4PublicRequestInput,
): V4PublicRequestDetails {
  if (
    (input.method === 'POST' &&
      (input.body === undefined || input.contentType !== 'application/json')) ||
    (input.method === 'GET' &&
      (input.body !== undefined || input.contentType !== undefined))
  )
    return fail()
  const host = new URL(input.origin).host
  const body = input.method === 'POST' ? encoder.encode(input.body!) : undefined
  const head =
    `${input.method} ${input.path} HTTP/1.1\r\n` +
    `host: ${host}\r\n` +
    'connection: close\r\n' +
    (input.contentEncoding === 'gzip' ? 'accept-encoding: gzip\r\n' : '') +
    (body
      ? `content-type: application/json\r\ncontent-length: ${body.length}\r\n`
      : '') +
    '\r\n'
  return {
    host,
    body,
    sentByteLength: encoder.encode(head).length + (body?.length ?? 0),
    ...(input.contentEncoding === 'gzip'
      ? { contentEncoding: input.contentEncoding }
      : {}),
  }
}

export function v4RequestDisclosureRanges(
  sent: Uint8Array,
  connector: V4Connector,
  captured: CapturedRequest,
): DisclosureRange[] {
  const replay = v4PublicRequestDetails({
    origin: connector.origin,
    method: connector.request.method,
    path: captured.path,
    body: captured.body,
    contentType: captured.content_type,
    contentEncoding: connector.response_content_encoding,
  })
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
  if (connector.response_content_encoding === 'gzip')
    allowed.add('accept-encoding')
  if (
    headers.size !== allowed.size ||
    [...headers.keys()].some((name) => !allowed.has(name)) ||
    [...allowed].some((name) => !headers.has(name)) ||
    headers.get('connection') !== 'close' ||
    (connector.response_content_encoding === 'gzip' &&
      headers.get('accept-encoding') !== 'gzip') ||
    !expectedAuthorities(connector.origin).has(
      headers.get('host')!.toLowerCase(),
    ) ||
    replay.sentByteLength > connector.request.max_sent_data
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
    if (!equal(actualBody, replay.body!)) return fail()
  }

  // Decoding the whole transcript above ensures there are no opaque bytes.
  if (encoder.encode(text).length !== sent.length) return fail()
  return [{ start: 0, end: sent.length }]
}

export async function v4ResponseDisclosureRanges(
  received: Uint8Array,
  connector: V4Connector,
): Promise<DisclosureRange[]> {
  if (
    !(received instanceof Uint8Array) ||
    received.length === 0 ||
    received.length > connector.request.max_recv_data ||
    received.length > MAX_V4_RESPONSE_BYTES
  )
    return fail()
  let entity: Uint8Array | undefined
  let decoded: Uint8Array | undefined
  try {
    entity = responseBody(received, connector)
    decoded =
      connector.response_content_encoding === 'gzip'
        ? await v4GunzipJson(entity, connector.max_decoded_data!)
        : entity
    if (connector.response_content_encoding !== 'gzip') {
      const text = decode(decoded)
      if (encoder.encode(text).length !== decoded.length) return fail()
    }
    new StrictResponseJsonParser(decoded).parse()
    return [{ start: 0, end: received.length }]
  } finally {
    if (decoded && decoded !== entity) decoded.fill(0)
    if (entity && connector.response_transfer_encoding === 'chunked')
      entity.fill(0)
  }
}
