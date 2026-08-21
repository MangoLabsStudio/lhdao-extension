import { sha256Hex } from '../canonical-json'
import type { BodyContentType } from './capture'
import type {
  V4ResolvedVariable,
  V4ScalarType,
  V4TemplateValue,
  V4VariableDeclaration,
} from './interpreter'

export type V4BodyMatch = Readonly<{
  exactBody: string
  semanticCanonical: string
  captured: Readonly<Record<string, string | boolean>>
}>

const MAX_BODY_BYTES = 8192
const MAX_DEPTH = 12
const MAX_NODES = 4096
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const utf8 = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

interface JsonObject {
  [key: string]: Json
}
type Json = null | boolean | string | number | Json[] | JsonObject
type Captured = Record<string, string | boolean>

function fail(message: string): never {
  throw new Error(message)
}

function unsafeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

class StrictJsonParser {
  #at = 0
  #nodes = 0

  constructor(private readonly source: string) {}

  parse(): Json {
    if (this.source.charCodeAt(0) === 0xfeff)
      fail('captured JSON body is invalid')
    this.#space()
    const value = this.#value(1)
    this.#space()
    if (this.#at !== this.source.length) fail('captured JSON body is invalid')
    return value
  }

  #node(depth: number): void {
    this.#nodes += 1
    if (depth > MAX_DEPTH || this.#nodes > MAX_NODES)
      fail('captured JSON body exceeds its structural limit')
  }

  #space(): void {
    while (true) {
      const code = this.source.charCodeAt(this.#at)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
        return
      this.#at += 1
    }
  }

  #value(depth: number): Json {
    this.#node(depth)
    const char = this.source[this.#at]
    if (char === '{') return this.#object(depth)
    if (char === '[') return this.#array(depth)
    if (char === '"') return this.#string()
    if (this.source.startsWith('true', this.#at))
      return this.#literal('true', true)
    if (this.source.startsWith('false', this.#at))
      return this.#literal('false', false)
    if (this.source.startsWith('null', this.#at))
      return this.#literal('null', null)
    return this.#number()
  }

  #object(depth: number): Record<string, Json> {
    this.#at += 1
    const result: Record<string, Json> = Object.create(null)
    const keys = new Set<string>()
    this.#space()
    if (this.source[this.#at] === '}') {
      this.#at += 1
      return result
    }
    while (true) {
      if (this.source[this.#at] !== '"') fail('captured JSON body is invalid')
      const key = this.#string()
      if (
        encoder.encode(key).length > 128 ||
        keys.has(key) ||
        PROTOTYPE_KEYS.has(key.toLowerCase())
      )
        fail('captured JSON body is invalid')
      keys.add(key)
      this.#space()
      if (this.source[this.#at] !== ':') fail('captured JSON body is invalid')
      this.#at += 1
      this.#space()
      Object.defineProperty(result, key, {
        value: this.#value(depth + 1),
        enumerable: true,
      })
      this.#space()
      if (this.source[this.#at] === '}') {
        this.#at += 1
        return result
      }
      if (this.source[this.#at] !== ',') fail('captured JSON body is invalid')
      this.#at += 1
      this.#space()
    }
  }

  #array(depth: number): Json[] {
    this.#at += 1
    const result: Json[] = []
    this.#space()
    if (this.source[this.#at] === ']') {
      this.#at += 1
      return result
    }
    while (true) {
      if (result.length >= 200) fail('captured JSON body is invalid')
      result.push(this.#value(depth + 1))
      this.#space()
      if (this.source[this.#at] === ']') {
        this.#at += 1
        return result
      }
      if (this.source[this.#at] !== ',') fail('captured JSON body is invalid')
      this.#at += 1
      this.#space()
    }
  }

  #string(): string {
    const start = this.#at
    this.#at += 1
    let escaped = false
    while (this.#at < this.source.length) {
      const code = this.source.charCodeAt(this.#at)
      if (!escaped && code === 0x22) {
        this.#at += 1
        let value: string
        try {
          value = JSON.parse(this.source.slice(start, this.#at)) as string
        } catch {
          return fail('captured JSON body is invalid')
        }
        if (unsafeString(value)) fail('captured JSON body is invalid')
        if (encoder.encode(value).length > 1024)
          fail('captured JSON body is invalid')
        return value
      }
      if (!escaped && code < 0x20) fail('captured JSON body is invalid')
      if (escaped) escaped = false
      else if (code === 0x5c) escaped = true
      this.#at += 1
    }
    return fail('captured JSON body is invalid')
  }

  #literal<T extends Json>(token: string, value: T): T {
    this.#at += token.length
    return value
  }

  #number(): number {
    const token = /^-?(?:0|[1-9]\d*)/.exec(this.source.slice(this.#at))?.[0]
    if (!token) fail('captured JSON body is invalid')
    this.#at += token.length
    const next = this.source[this.#at]
    if (next === '.' || next === 'e' || next === 'E' || next === '+')
      fail('captured JSON body is invalid')
    const value = Number(token)
    if (!Number.isSafeInteger(value)) fail('captured JSON body is invalid')
    return value
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!
    if (difference) return difference
  }
  return a.length - b.length
}

function canonicalJson(value: Json): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number')
    return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`
}

function validScalar(
  value: unknown,
  type: V4ScalarType,
): value is string | boolean {
  if (type === 'BOOLEAN') return typeof value === 'boolean'
  if (typeof value !== 'string' || unsafeString(value)) return false
  if (type === 'INTEGER') return /^-?(?:0|[1-9]\d*)$/.test(value)
  if (type === 'DECIMAL') {
    if (
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
      /^-0(?:\.0+)?$/.test(value)
    )
      return false
    const [whole, fraction = ''] = value.replace('-', '').split('.')
    if (fraction.length > 8) return false
    const scaled =
      BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))
    return scaled <= 99_999_999_999_999_999_999n
  }
  if (type === 'UTC_TIMESTAMP') {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
        value,
      )
    if (!match) return false
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])
    const second = Number(match[6])
    const offsetHour = match[8] === undefined ? 0 : Number(match[8])
    const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= (days[month - 1] ?? 0) &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      offsetHour <= 23 &&
      offsetMinute <= 59
    )
  }
  return true
}

function validDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    date.toISOString().slice(0, 10) === value
  )
}

function normalizedCaptured(
  value: unknown,
  declaration: V4VariableDeclaration,
): string | boolean | null {
  let normalized: string | boolean
  if (declaration.scalarType === 'BOOLEAN') {
    if (declaration.constraints) return null
    if (value === true || value === 'true') normalized = true
    else if (value === false || value === 'false') normalized = false
    else return null
  } else if (
    declaration.scalarType === 'INTEGER' &&
    typeof value === 'number' &&
    Number.isSafeInteger(value)
  )
    normalized = String(value)
  else if (typeof value === 'string') normalized = value
  else return null
  if (!validScalar(normalized, declaration.scalarType)) return null
  const length = [...String(normalized)].length
  const constraints = declaration.constraints
  if (
    (constraints?.minLength !== undefined && length < constraints.minLength) ||
    (constraints?.maxLength !== undefined && length > constraints.maxLength) ||
    (constraints?.pattern === 'ACCOUNT_ID' &&
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(String(normalized))) ||
    (constraints?.pattern === 'EVM_ADDRESS' &&
      !/^0x[0-9A-Fa-f]{40}$/.test(String(normalized))) ||
    (constraints?.pattern === 'ISO_DATE' && !validDate(String(normalized))) ||
    (constraints?.pattern === 'DECIMAL' && !validScalar(normalized, 'DECIMAL'))
  )
    return null
  return normalized
}

function declarationMap(
  declarations: readonly V4VariableDeclaration[],
): Map<string, V4VariableDeclaration> {
  return new Map(declarations.map((item) => [item.name, item]))
}

function matchValue(
  candidate: Json,
  template: V4TemplateValue,
  resolved: Readonly<Record<string, V4ResolvedVariable>>,
  declarations: ReadonlyMap<string, V4VariableDeclaration>,
  captured: Captured,
  stringEncoded: boolean,
): boolean {
  if (template === null || typeof template !== 'object')
    return stringEncoded
      ? candidate === String(template)
      : candidate === template
  if (Array.isArray(template))
    return (
      Array.isArray(candidate) &&
      candidate.length === template.length &&
      template.every((item, index) =>
        matchValue(
          candidate[index]!,
          item,
          resolved,
          declarations,
          captured,
          stringEncoded,
        ),
      )
    )
  const input = template as Record<string, unknown>
  if (Object.hasOwn(input, '$var')) {
    const name = input.$var
    if (typeof name !== 'string') fail('captured request variable is invalid')
    const known = resolved[name]
    if (known)
      return stringEncoded
        ? candidate === String(known.value)
        : validScalar(candidate, known.type) && candidate === known.value
    const declaration = declarations.get(name)
    if (!declaration || declaration.source.kind !== 'CAPTURED_REQUEST')
      fail('captured request variable is invalid')
    const normalized = normalizedCaptured(candidate, declaration)
    if (
      normalized === null ||
      (stringEncoded
        ? candidate !== String(normalized)
        : candidate !== normalized)
    )
      fail('captured request variable is invalid')
    const previous = captured[name]
    if (previous !== undefined && previous !== normalized)
      fail('captured request variable is ambiguous')
    captured[name] = normalized
    return true
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    return false
  if (Object.hasOwn(input, '$object')) {
    const wrapper = input.$object as {
      mode: 'ALLOW_EXTRA'
      fields: Record<string, V4TemplateValue>
    }
    const fields = wrapper.fields
    return Object.keys(fields).every(
      (key) =>
        Object.hasOwn(candidate, key) &&
        matchValue(
          candidate[key]!,
          fields[key]!,
          resolved,
          declarations,
          captured,
          stringEncoded,
        ),
    )
  }
  const candidateKeys = Object.keys(candidate)
  const templateRecord = template as Record<string, V4TemplateValue>
  const templateKeys = Object.keys(templateRecord)
  return (
    candidateKeys.length === templateKeys.length &&
    templateKeys.every(
      (key) =>
        Object.hasOwn(candidate, key) &&
        matchValue(
          candidate[key]!,
          templateRecord[key]!,
          resolved,
          declarations,
          captured,
          stringEncoded,
        ),
    )
  )
}

export function matchV4Value(
  candidate: Json,
  template: V4TemplateValue,
  resolved: Readonly<Record<string, V4ResolvedVariable>>,
  declarations: readonly V4VariableDeclaration[] = [],
  stringEncoded = false,
): Readonly<Record<string, string | boolean>> | null {
  const captured: Captured = {}
  return matchValue(
    candidate,
    template,
    resolved,
    declarationMap(declarations),
    captured,
    stringEncoded,
  )
    ? captured
    : null
}

function parseForm(body: string): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null)
  if (!body) return result
  const pairs = body.split('&')
  if (pairs.length > 2048) fail('captured form body is invalid')
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator < 0 || pair.indexOf('=', separator + 1) >= 0)
      fail('captured form body is invalid')
    const rawName = pair.slice(0, separator)
    const rawValue = pair.slice(separator + 1)
    let name: string
    let value: string
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '))
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      return fail('captured form body is invalid')
    }
    if (
      !name ||
      encoder.encode(name).length > 128 ||
      encoder.encode(value).length > 1024 ||
      unsafeString(name) ||
      unsafeString(value) ||
      PROTOTYPE_KEYS.has(name.toLowerCase())
    )
      fail('captured form body is invalid')
    const values = result[name] ?? []
    values.push(value)
    result[name] = values
  }
  return result
}

function canonicalForm(value: Record<string, string[]>): string {
  const output = new URLSearchParams()
  for (const name of Object.keys(value).sort(compareCodePoints))
    for (const item of value[name]!) output.append(name, item)
  return output.toString()
}

function matchForm(
  form: Record<string, string[]>,
  template: V4TemplateValue,
  resolved: Readonly<Record<string, V4ResolvedVariable>>,
  declarations: readonly V4VariableDeclaration[],
): Captured | null {
  if (
    !template ||
    typeof template !== 'object' ||
    Array.isArray(template) ||
    '$var' in template ||
    '$object' in template
  )
    fail('captured form template is invalid')
  const templateKeys = Object.keys(template)
  if (Object.keys(form).length !== templateKeys.length) return null
  const captured: Captured = {}
  const declarationsByName = declarationMap(declarations)
  for (const key of templateKeys) {
    const values = form[key]
    if (!values) return null
    const expected = template[key]!
    if (Array.isArray(expected)) {
      if (values.length !== expected.length) return null
      for (let index = 0; index < expected.length; index += 1) {
        if (
          !matchValue(
            values[index]!,
            expected[index]!,
            resolved,
            declarationsByName,
            captured,
            false,
          )
        )
          return null
      }
    } else {
      if (
        values.length !== 1 ||
        !matchValue(
          values[0]!,
          expected,
          resolved,
          declarationsByName,
          captured,
          false,
        )
      )
        return null
    }
  }
  return captured
}

export function v4SemanticDigest(semanticCanonical: string): Promise<string> {
  return sha256Hex(semanticCanonical)
}

export function matchV4Body(
  raw: Uint8Array,
  contentType: BodyContentType,
  template: V4TemplateValue,
  resolved: Readonly<Record<string, V4ResolvedVariable>>,
  declarations: readonly V4VariableDeclaration[] = [],
): V4BodyMatch | null {
  if (raw.byteLength > MAX_BODY_BYTES) fail('captured body exceeds its limit')
  let exactBody: string
  try {
    exactBody = utf8.decode(raw)
  } catch {
    return fail('captured body is not valid UTF-8')
  }
  if (contentType === 'application/json') {
    const value = new StrictJsonParser(exactBody).parse()
    const captured = matchV4Value(value, template, resolved, declarations)
    return captured === null
      ? null
      : { exactBody, semanticCanonical: canonicalJson(value), captured }
  }
  const form = parseForm(exactBody)
  const captured = matchForm(form, template, resolved, declarations)
  return captured === null
    ? null
    : { exactBody, semanticCanonical: canonicalForm(form), captured }
}
