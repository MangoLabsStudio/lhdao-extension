/** Pure evaluator extracted from frontend product-zktls-v2-pipeline.ts (2026-09-10).
 * Keep exact decimal, UTC, UNIQUE and reduction semantics aligned with frontend.
 * Authoring normalization and its dependency chain deliberately remain outside this module.
 * Shared field-difference and EVM-prefix fixtures cover parity in zktls-review-preview.test.ts.
 */
import { Decimal } from 'decimal.js'
import type {
  V4Pipeline as ProductZkTlsPipelineV2,
  V4Predicate as ProductZkTlsPredicateV2,
  V4ScalarPredicate as ProductZkTlsScalarPredicateV2,
  V4ResolvedVariable as ResolvedVariable,
} from './interpreter'

type ProductZkTlsTemplateScalar = null | boolean | string | number

export function parseProductZkTlsIsoInstant(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    )
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

type ProductJsonPathSegment =
  | { kind: 'FIELD'; key: string }
  | { kind: 'INDEX'; index: number }
  | { kind: 'COLLECTION' }

const PreviewDecimal = Decimal.clone({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
})
const DifferenceDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
})
const DECIMAL_MAX = new PreviewDecimal('999999999999.99999999')
const DIFFERENCE_DECIMAL_MAX = new DifferenceDecimal(
  '999999999999.999999999999999999',
)
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const INTEGER_PATTERN = /^-?(?:0|[1-9][0-9]*)$/
const PATH_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const pathEncoder = new TextEncoder()

function hasProductZkTlsDecimalLexicalShape(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value)
}

function isProductZkTlsDecimalWithinBounds(value: Decimal): boolean {
  return (
    value.isFinite() &&
    value.abs().lte(DECIMAL_MAX) &&
    value.decimalPlaces() <= 8
  )
}

function isProductZkTlsDifferenceDecimalWithinBounds(value: Decimal): boolean {
  return (
    value.isFinite() &&
    value.abs().lte(DIFFERENCE_DECIMAL_MAX) &&
    value.decimalPlaces() <= 18
  )
}

function parseCanonicalProductZkTlsDecimal(
  value: unknown,
  integer = false,
  extendedPrecision = false,
): Decimal | null {
  let lexeme: string
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return null
    lexeme = String(value)
  } else if (
    typeof value === 'string' &&
    (integer ? INTEGER_PATTERN : DECIMAL_PATTERN).test(value)
  ) {
    lexeme = value
  } else {
    return null
  }
  const decimalPoint = lexeme.indexOf('.')
  if (
    (decimalPoint >= 0 &&
      lexeme.length - decimalPoint - 1 > (extendedPrecision ? 18 : 8)) ||
    /^-0(?:\.0+)?$/.test(lexeme)
  ) {
    return null
  }
  try {
    const parsed = extendedPrecision
      ? new DifferenceDecimal(lexeme)
      : new PreviewDecimal(lexeme)
    return (extendedPrecision
      ? isProductZkTlsDifferenceDecimalWithinBounds(parsed)
      : isProductZkTlsDecimalWithinBounds(parsed)) &&
      (!integer || parsed.isInteger())
      ? parsed
      : null
  } catch {
    return null
  }
}

function jsonPathFail(): never {
  throw new Error('PRODUCT_ZKTLS_JSON_PATH_INVALID')
}

function safePathKey(value: string): string {
  if (
    value.length === 0 ||
    pathEncoder.encode(value).length > 128 ||
    PATH_PROTOTYPE_KEYS.has(value)
  ) {
    return jsonPathFail()
  }
  return value
}

function parseProductJsonPath(path: string): ProductJsonPathSegment[] {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    pathEncoder.encode(path).length > 256 ||
    path[0] !== '$'
  ) {
    return jsonPathFail()
  }
  const segments: ProductJsonPathSegment[] = []
  let offset = 1
  let collections = 0
  while (offset < path.length) {
    if (segments.length >= 24) return jsonPathFail()
    if (path[offset] === '.') {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(offset + 1))
      if (!match) return jsonPathFail()
      segments.push({ kind: 'FIELD', key: safePathKey(match[0]) })
      offset += match[0].length + 1
      continue
    }
    if (path[offset] !== '[') return jsonPathFail()
    if (path.startsWith('[*]', offset)) {
      collections += 1
      if (collections > 1) return jsonPathFail()
      segments.push({ kind: 'COLLECTION' })
      offset += 3
      continue
    }
    const indexMatch = /^\[(0|[1-9][0-9]*)\]/.exec(path.slice(offset))
    if (indexMatch) {
      const index = Number(indexMatch[1])
      if (!Number.isSafeInteger(index) || index >= 200) return jsonPathFail()
      segments.push({ kind: 'INDEX', index })
      offset += indexMatch[0].length
      continue
    }
    const quote = path[offset + 1]
    if (quote !== '"' && quote !== "'") return jsonPathFail()
    const close = path.indexOf(`${quote}]`, offset + 2)
    if (close < 0) return jsonPathFail()
    const key = path.slice(offset + 2, close)
    if (key.includes('"') || key.includes("'") || key.includes('\\')) {
      return jsonPathFail()
    }
    segments.push({ kind: 'FIELD', key: safePathKey(key) })
    offset = close + 2
  }
  return segments
}

function ownValue(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== 'object') return jsonPathFail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor?.enumerable || !('value' in descriptor)) return jsonPathFail()
  return descriptor.value
}

function selectProductJsonPath(
  value: unknown,
  path: readonly ProductJsonPathSegment[],
): readonly unknown[] {
  let selected: readonly unknown[] = [value]
  for (const segment of path) {
    if (segment.kind === 'COLLECTION') {
      if (selected.length !== 1 || !Array.isArray(selected[0])) {
        return jsonPathFail()
      }
      const array = selected[0]
      if (array.length > 200) return jsonPathFail()
      selected = array.map((_item, index) => ownValue(array, String(index)))
      continue
    }
    selected = selected.map((item) => {
      if (segment.kind === 'INDEX') {
        if (!Array.isArray(item) || segment.index >= item.length) {
          return jsonPathFail()
        }
        return ownValue(item, String(segment.index))
      }
      if (Array.isArray(item)) return jsonPathFail()
      return ownValue(item, segment.key)
    })
  }
  if (selected.length > 200) return jsonPathFail()
  return selected
}

export type ProductZkTlsScalar =
  | Readonly<{ type: 'number'; value: string; unit?: string }>
  | Readonly<{ type: 'string'; value: string; unit?: string }>
  | Readonly<{ type: 'boolean'; value: boolean; unit?: string }>

type NumericScalar =
  | Readonly<{ kind: 'DECIMAL'; value: Decimal }>
  | Readonly<{ kind: 'INTEGER'; value: Decimal }>
type EvaluatedScalar =
  | NumericScalar
  | Readonly<{ kind: 'BOOLEAN'; value: boolean }>
  | Readonly<{ kind: 'STRING'; value: string }>
  | Readonly<{ kind: 'UTC_TIMESTAMP'; value: string; timestamp: number }>
type Row = Readonly<{ value: unknown; order?: EvaluatedScalar }>

const COUNT_UNITS = new Set(['count', 'days', 'items'])
const PIPELINE_FIELDS = new Set([
  'output',
  'sourcePath',
  'filter',
  'orderBy',
  'groupBy',
  'valuePath',
  'difference',
  'cast',
  'fixedDecimals',
  'absolute',
  'timestamp',
  'coverage',
  'reduce',
  'postFilter',
  'finalReduce',
  'valueUnit',
  'outputUnit',
])
const CASTS = new Set<ProductZkTlsPipelineV2['cast']>([
  'DECIMAL',
  'INTEGER',
  'BOOLEAN',
  'STRING',
  'UTC_TIMESTAMP',
  'EVM_ADDRESS_FROM_BYTES32_PREFIX',
])
const REDUCERS = new Set<NonNullable<ProductZkTlsPipelineV2['reduce']>>([
  'SUM',
  'COUNT',
  'DISTINCT_COUNT',
  'UNIQUE',
  'MIN',
  'MAX',
  'AVG',
  'FIRST',
  'LAST',
  'LAST_MINUS_FIRST',
])
const FINAL_REDUCERS = new Set<
  NonNullable<ProductZkTlsPipelineV2['finalReduce']>
>(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG'])
const COMPARE_OPS = new Set(['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE'])

function fail(): never {
  throw new Error('PRODUCT_ZKTLS_PIPELINE_EVALUATION_INVALID')
}

export class ProductZkTlsInsufficientDataError extends Error {
  constructor() {
    super('PRODUCT_ZKTLS_INSUFFICIENT_DATA')
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key)
}

function exactFields(value: object, fields: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !fields.has(key))) fail()
}

function exactObjectFields(value: unknown, fields: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail()
  }
  const keys = Object.keys(value)
  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key))
  ) {
    fail()
  }
}

function path(value: unknown): readonly ProductJsonPathSegment[] {
  if (typeof value !== 'string') return fail()
  return parseProductJsonPath(value)
}

function differencePaths(value: unknown): Readonly<{
  left: readonly ProductJsonPathSegment[]
  right: readonly ProductJsonPathSegment[]
}> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail()
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== 2 ||
      !keys.includes('leftPath') ||
      !keys.includes('rightPath')
    ) {
      return fail()
    }
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      if (typeof key !== 'string') return fail()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return fail()
      snapshot[key] = descriptor.value
    }
    structuredClone(value)
    const left = path(snapshot.leftPath)
    const right = path(snapshot.rightPath)
    if (
      left.some((segment) => segment.kind === 'COLLECTION') ||
      right.some((segment) => segment.kind === 'COLLECTION') ||
      JSON.stringify(left) === JSON.stringify(right)
    ) {
      return fail()
    }
    return { left, right }
  } catch {
    return fail()
  }
}

function singleSelection(
  value: unknown,
  segments: readonly ProductJsonPathSegment[],
): unknown {
  const selected = selectProductJsonPath(value, segments)
  if (selected.length !== 1) return fail()
  return selected[0]
}

function optionalSelection(
  value: unknown,
  segments: readonly ProductJsonPathSegment[],
): readonly unknown[] {
  try {
    return selectProductJsonPath(value, segments)
  } catch {
    return []
  }
}

function checkedDecimal(value: Decimal): Decimal {
  if (!isProductZkTlsDecimalWithinBounds(value)) return fail()
  return value
}

function checkedDifferenceDecimal(value: Decimal): Decimal {
  if (!isProductZkTlsDifferenceDecimalWithinBounds(value)) {
    return fail()
  }
  return value
}

function decimal(
  value: unknown,
  integer: boolean,
  extendedPrecision = false,
): NumericScalar {
  // The future disclosure parser must retain the raw JSON numeric lexeme.
  // Plain JSON.parse fractional/unsafe numbers fail closed at this boundary.
  const parsed = parseCanonicalProductZkTlsDecimal(
    value,
    integer,
    extendedPrecision,
  )
  if (parsed === null) return fail()
  return { kind: integer ? 'INTEGER' : 'DECIMAL', value: parsed }
}

const RAW_INTEGER = /^-?(?:0|[1-9][0-9]*)$/

function transformedNumber(
  value: unknown,
  pipeline: ProductZkTlsPipelineV2,
  applyAbsolute = true,
  enforceInteger = true,
  differenceOperand = false,
): NumericScalar {
  const integer = pipeline.cast === 'INTEGER'
  const fixedDecimals = pipeline.fixedDecimals
  if (fixedDecimals === undefined && pipeline.absolute === undefined) {
    return decimal(value, integer && enforceInteger, differenceOperand)
  }
  let parsed: Decimal
  if (fixedDecimals === undefined) {
    parsed = decimal(value, integer && enforceInteger, differenceOperand).value
  } else {
    let lexeme: string
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      !Object.is(value, -0)
    ) {
      lexeme = String(value)
    } else if (typeof value === 'string' && RAW_INTEGER.test(value)) {
      lexeme = value
    } else {
      return fail()
    }
    if (/^-0$/.test(lexeme)) return fail()
    try {
      const DecimalConstructor = differenceOperand
        ? DifferenceDecimal
        : PreviewDecimal
      parsed = new DecimalConstructor(lexeme).div(
        new DecimalConstructor(10).pow(fixedDecimals),
      )
    } catch {
      return fail()
    }
  }
  if (applyAbsolute && pipeline.absolute) parsed = parsed.abs()
  if (differenceOperand) checkedDifferenceDecimal(parsed)
  else checkedDecimal(parsed)
  if (enforceInteger && integer && !parsed.isInteger()) return fail()
  return {
    kind: integer && enforceInteger ? 'INTEGER' : 'DECIMAL',
    value: parsed,
  }
}

function subtractFields(
  value: unknown,
  difference: ReturnType<typeof differencePaths>,
  pipeline: ProductZkTlsPipelineV2,
): NumericScalar {
  const left = transformedNumber(
    singleSelection(value, difference.left),
    pipeline,
    false,
    false,
    true,
  ).value
  const right = transformedNumber(
    singleSelection(value, difference.right),
    pipeline,
    false,
    false,
    true,
  ).value
  let result = checkedDifferenceDecimal(left.sub(right))
  if (pipeline.absolute) result = result.abs()
  checkedDifferenceDecimal(result)
  if (pipeline.cast === 'INTEGER' && !result.isInteger()) return fail()
  return {
    kind: pipeline.cast === 'INTEGER' ? 'INTEGER' : 'DECIMAL',
    value: result,
  }
}

function timestamp(value: unknown): EvaluatedScalar {
  if (typeof value !== 'string') return fail()
  const parsed = parseProductZkTlsIsoInstant(value)
  if (parsed === null) return fail()
  return {
    kind: 'UTC_TIMESTAMP',
    value: new Date(parsed).toISOString(),
    timestamp: parsed,
  }
}

function declaredTimestamp(
  value: unknown,
  format: NonNullable<ProductZkTlsPipelineV2['timestamp']>['format'],
): EvaluatedScalar {
  if (format === 'ISO_8601') return timestamp(value)
  let integer: number
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  ) {
    integer = value
  } else if (typeof value === 'string' && RAW_INTEGER.test(value)) {
    integer = Number(value)
    if (!Number.isSafeInteger(integer) || /^-0$/.test(value)) return fail()
  } else {
    return fail()
  }
  const milliseconds = format === 'UNIX_SECONDS' ? integer * 1000 : integer
  if (!Number.isSafeInteger(milliseconds)) return fail()
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) return fail()
  return {
    kind: 'UTC_TIMESTAMP',
    value: date.toISOString(),
    timestamp: milliseconds,
  }
}

function evmAddressFromBytes32Prefix(value: unknown): EvaluatedScalar {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    return fail()
  }
  const address = value.slice(0, 42).toLowerCase()
  if (address === `0x${'0'.repeat(40)}`) return fail()
  return { kind: 'STRING', value: address }
}

function castScalar(
  value: unknown,
  cast: ProductZkTlsPipelineV2['cast'],
): EvaluatedScalar {
  if (cast === 'DECIMAL') return decimal(value, false)
  if (cast === 'INTEGER') return decimal(value, true)
  if (cast === 'BOOLEAN') {
    if (typeof value !== 'boolean') return fail()
    return { kind: 'BOOLEAN', value }
  }
  if (cast === 'STRING') {
    if (typeof value !== 'string') return fail()
    return { kind: 'STRING', value }
  }
  if (cast === 'UTC_TIMESTAMP') return timestamp(value)
  if (cast === 'EVM_ADDRESS_FROM_BYTES32_PREFIX') {
    return evmAddressFromBytes32Prefix(value)
  }
  return fail()
}

function castPipelineScalar(
  value: unknown,
  pipeline: ProductZkTlsPipelineV2,
): EvaluatedScalar {
  if (pipeline.cast === 'DECIMAL' || pipeline.cast === 'INTEGER') {
    return transformedNumber(value, pipeline)
  }
  return castScalar(value, pipeline.cast)
}

function inferScalar(value: unknown): EvaluatedScalar {
  if (typeof value === 'boolean') return { kind: 'BOOLEAN', value }
  if (typeof value === 'number') return decimal(value, true)
  if (typeof value !== 'string') return fail()
  const instant = parseProductZkTlsIsoInstant(value)
  if (instant !== null) return timestamp(value)
  const decimalValue = parseCanonicalProductZkTlsDecimal(value)
  if (decimalValue !== null) return { kind: 'DECIMAL', value: decimalValue }
  if (hasProductZkTlsDecimalLexicalShape(value)) return fail()
  return { kind: 'STRING', value }
}

function compareScalars(left: EvaluatedScalar, right: EvaluatedScalar): number {
  if (
    (left.kind === 'DECIMAL' || left.kind === 'INTEGER') &&
    (right.kind === 'DECIMAL' || right.kind === 'INTEGER')
  ) {
    return left.value.comparedTo(right.value)
  }
  if (left.kind !== right.kind) return fail()
  if (left.kind === 'BOOLEAN' && right.kind === 'BOOLEAN') {
    return left.value === right.value ? 0 : left.value ? 1 : -1
  }
  if (left.kind === 'UTC_TIMESTAMP' && right.kind === 'UTC_TIMESTAMP') {
    return left.timestamp < right.timestamp
      ? -1
      : left.timestamp > right.timestamp
        ? 1
        : 0
  }
  if (left.kind === 'STRING' && right.kind === 'STRING') {
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0
  }
  return fail()
}

function variable(
  name: unknown,
  variables: Readonly<Record<string, ResolvedVariable>>,
): EvaluatedScalar {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)
  ) {
    return fail()
  }
  if (!hasOwn(variables, name)) return fail()
  const resolved = variables[name]
  exactObjectFields(resolved, ['type', 'value'])
  if (resolved.type === 'DECIMAL') return decimal(resolved.value, false)
  if (resolved.type === 'INTEGER') return decimal(resolved.value, true)
  if (resolved.type === 'BOOLEAN') {
    if (typeof resolved.value !== 'boolean') return fail()
    return { kind: 'BOOLEAN', value: resolved.value }
  }
  if (resolved.type === 'STRING') {
    if (typeof resolved.value !== 'string') return fail()
    return { kind: 'STRING', value: resolved.value }
  }
  if (resolved.type === 'UTC_TIMESTAMP') return timestamp(resolved.value)
  return fail()
}

function reference(
  value: unknown,
  variables: Readonly<Record<string, ResolvedVariable>>,
): EvaluatedScalar | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  exactObjectFields(value, ['$var'])
  return variable((value as { $var: unknown }).$var, variables)
}

function literalScalar(value: ProductZkTlsTemplateScalar): EvaluatedScalar {
  if (value === null) return fail()
  if (typeof value === 'number') return decimal(value, true)
  return inferScalar(value)
}

function validatePredicateValue(
  value: unknown,
  variables: Readonly<Record<string, ResolvedVariable>>,
): void {
  if (value !== null && typeof value === 'object') {
    reference(value, variables)
    return
  }
  if (
    value !== null &&
    typeof value !== 'boolean' &&
    typeof value !== 'string' &&
    (typeof value !== 'number' || !Number.isSafeInteger(value))
  ) {
    fail()
  }
}

function validatePredicateDefinition(
  rule: ProductZkTlsPredicateV2,
  variables: Readonly<Record<string, ResolvedVariable>>,
  state: { leaves: number },
  depth = 1,
): void {
  if (depth > 4 || rule === null || typeof rule !== 'object') fail()
  if (rule.op === 'ALL' || rule.op === 'ANY') {
    exactObjectFields(rule, ['op', 'predicates'])
    if (!Array.isArray(rule.predicates) || rule.predicates.length === 0) fail()
    for (const child of rule.predicates) {
      validatePredicateDefinition(child, variables, state, depth + 1)
    }
    return
  }
  state.leaves += 1
  if (state.leaves > 32) fail()
  if (rule.op === 'EXISTS') {
    exactObjectFields(rule, ['op', 'path'])
    path(rule.path)
    return
  }
  if (!('path' in rule) || !('value' in rule)) fail()
  if (rule.op !== 'IN' && !COMPARE_OPS.has(rule.op)) fail()
  exactObjectFields(rule, ['op', 'path', 'value'])
  path(rule.path)
  if (rule.op === 'IN') {
    if (
      !Array.isArray(rule.value) ||
      rule.value.length === 0 ||
      rule.value.length > 32
    ) {
      fail()
    }
    for (const value of rule.value) validatePredicateValue(value, variables)
    return
  }
  if (Array.isArray(rule.value)) fail()
  validatePredicateValue(rule.value, variables)
}

function comparisonResult(
  comparison: number,
  op: 'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE',
): boolean {
  if (op === 'EQ') return comparison === 0
  if (op === 'NE') return comparison !== 0
  if (op === 'GT') return comparison > 0
  if (op === 'GTE') return comparison >= 0
  if (op === 'LT') return comparison < 0
  return comparison <= 0
}

/** Conservative dependency check: never interpret a redaction marker as data. */
export function productZkTlsPipelineUsesMarker(
  pipeline: ProductZkTlsPipelineV2,
  response: unknown,
  marker: string,
): boolean {
  const selected = selectProductJsonPath(response, path(pipeline.sourcePath))
  const relative = new Set<string>()
  function predicatePaths(predicate?: ProductZkTlsPredicateV2) {
    if (!predicate) return
    if ('predicates' in predicate) predicate.predicates.forEach(predicatePaths)
    else relative.add(predicate.path)
  }
  predicatePaths(pipeline.filter)
  for (const dependency of [
    pipeline.valuePath,
    pipeline.difference?.leftPath,
    pipeline.difference?.rightPath,
    pipeline.orderBy?.path,
    pipeline.groupBy?.path,
    pipeline.timestamp?.path,
  ])
    if (dependency) relative.add(dependency)
  if (
    !pipeline.valuePath &&
    !pipeline.difference &&
    pipeline.reduce !== 'COUNT'
  )
    relative.add('$')
  return selected.some((value) =>
    [...relative].some((dependency) =>
      selectProductJsonPath(value, path(dependency)).some(
        (item) => item === marker,
      ),
    ),
  )
}

function compareRaw(
  left: unknown,
  right: ProductZkTlsTemplateScalar | { $var: string },
  op: 'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE',
  variables: Readonly<Record<string, ResolvedVariable>>,
): boolean {
  if (right === null) {
    if (op !== 'EQ' && op !== 'NE') return fail()
    return op === 'EQ' ? left === null : left !== null
  }
  const referenced = reference(right, variables)
  const rightScalar =
    referenced ?? literalScalar(right as ProductZkTlsTemplateScalar)
  const leftScalar = castScalar(left, rightScalar.kind)
  if (rightScalar.kind === 'BOOLEAN' && op !== 'EQ' && op !== 'NE') {
    return fail()
  }
  return comparisonResult(compareScalars(leftScalar, rightScalar), op)
}

function predicate(
  rule: ProductZkTlsPredicateV2,
  value: unknown,
  variables: Readonly<Record<string, ResolvedVariable>>,
  state: { leaves: number },
  depth = 1,
): boolean {
  if (depth > 4 || rule === null || typeof rule !== 'object') return fail()
  if (rule.op === 'ALL' || rule.op === 'ANY') {
    exactObjectFields(rule, ['op', 'predicates'])
    if (!Array.isArray(rule.predicates) || rule.predicates.length === 0) {
      return fail()
    }
    const results = rule.predicates.map((child) =>
      predicate(child, value, variables, state, depth + 1),
    )
    return rule.op === 'ALL' ? results.every(Boolean) : results.some(Boolean)
  }
  state.leaves += 1
  if (state.leaves > 32) return fail()
  if (rule.op === 'EXISTS') {
    exactObjectFields(rule, ['op', 'path'])
    return optionalSelection(value, path(rule.path)).length > 0
  }
  if (!('path' in rule) || !('value' in rule)) return fail()
  exactObjectFields(rule, ['op', 'path', 'value'])
  const selected = singleSelection(value, path(rule.path))
  if (rule.op === 'IN') {
    if (
      !Array.isArray(rule.value) ||
      rule.value.length === 0 ||
      rule.value.length > 32
    ) {
      return fail()
    }
    const results = rule.value.map((candidate) =>
      compareRaw(selected, candidate, 'EQ', variables),
    )
    return results.some(Boolean)
  }
  if (Array.isArray(rule.value)) return fail()
  return compareRaw(selected, rule.value, rule.op, variables)
}

function scalarPredicate(
  rule: ProductZkTlsScalarPredicateV2,
  value: EvaluatedScalar,
  variables: Readonly<Record<string, ResolvedVariable>>,
): boolean {
  exactObjectFields(
    rule,
    hasOwn(rule, 'unit') ? ['op', 'value', 'unit'] : ['op', 'value'],
  )
  if (rule.value === null) {
    if (value.kind !== 'STRING' || (rule.op !== 'EQ' && rule.op !== 'NE')) {
      return fail()
    }
    return rule.op === 'NE'
  }
  const referenced = reference(rule.value, variables)
  const right = referenced ?? castScalar(rule.value, value.kind)
  if (referenced && referenced.kind !== value.kind) return fail()
  if (
    (value.kind === 'BOOLEAN' || value.kind === 'STRING') &&
    rule.op !== 'EQ' &&
    rule.op !== 'NE'
  ) {
    return fail()
  }
  return comparisonResult(compareScalars(value, right), rule.op)
}

function reducerSupports(
  reduce:
    | NonNullable<ProductZkTlsPipelineV2['reduce']>
    | NonNullable<ProductZkTlsPipelineV2['finalReduce']>,
  cast: ProductZkTlsPipelineV2['cast'],
): boolean {
  if (
    reduce === 'COUNT' ||
    reduce === 'DISTINCT_COUNT' ||
    reduce === 'UNIQUE' ||
    reduce === 'FIRST' ||
    reduce === 'LAST'
  ) {
    return true
  }
  if (reduce === 'MIN' || reduce === 'MAX') return cast !== 'BOOLEAN'
  return cast === 'DECIMAL' || cast === 'INTEGER'
}

function reducerOutputCast(
  reduce: NonNullable<ProductZkTlsPipelineV2['reduce']>,
  cast: ProductZkTlsPipelineV2['cast'],
): ProductZkTlsPipelineV2['cast'] {
  if (reduce === 'COUNT' || reduce === 'DISTINCT_COUNT') return 'INTEGER'
  if (reduce === 'AVG') return 'DECIMAL'
  return cast
}

function validateScalarPredicateDefinition(
  rule: ProductZkTlsScalarPredicateV2,
  variables: Readonly<Record<string, ResolvedVariable>>,
  cast: ProductZkTlsPipelineV2['cast'],
): void {
  exactObjectFields(
    rule,
    hasOwn(rule, 'unit') ? ['op', 'value', 'unit'] : ['op', 'value'],
  )
  if (!COMPARE_OPS.has(rule.op)) fail()
  if (rule.value === null) {
    if (cast !== 'STRING' || (rule.op !== 'EQ' && rule.op !== 'NE')) fail()
    return
  }
  const referenced = reference(rule.value, variables)
  if (referenced) {
    if (referenced.kind !== cast) fail()
  } else {
    castScalar(rule.value, cast)
  }
  if (
    (cast === 'BOOLEAN' || cast === 'STRING') &&
    rule.op !== 'EQ' &&
    rule.op !== 'NE'
  ) {
    fail()
  }
}

function selectValues(
  rows: readonly Row[],
  valuePath: readonly ProductJsonPathSegment[] | undefined,
  difference: ReturnType<typeof differencePaths> | undefined,
  pipeline: ProductZkTlsPipelineV2,
): EvaluatedScalar[] {
  return rows.map((row) =>
    difference
      ? subtractFields(row.value, difference, pipeline)
      : castPipelineScalar(
          valuePath ? singleSelection(row.value, valuePath) : row.value,
          pipeline,
        ),
  )
}

function numeric(value: EvaluatedScalar): NumericScalar {
  if (value.kind !== 'DECIMAL' && value.kind !== 'INTEGER') return fail()
  return value
}

function sum(
  values: readonly EvaluatedScalar[],
  cast: ProductZkTlsPipelineV2['cast'],
  extendedPrecision = false,
): NumericScalar {
  let result = extendedPrecision
    ? new DifferenceDecimal(0)
    : new PreviewDecimal(0)
  for (const value of values) {
    result = extendedPrecision
      ? checkedDifferenceDecimal(result.add(numeric(value).value))
      : checkedDecimal(result.add(numeric(value).value))
  }
  return cast === 'INTEGER'
    ? { kind: 'INTEGER', value: result }
    : { kind: 'DECIMAL', value: result }
}

function reduceScalars(
  values: readonly EvaluatedScalar[],
  reduce:
    | NonNullable<ProductZkTlsPipelineV2['reduce']>
    | NonNullable<ProductZkTlsPipelineV2['finalReduce']>,
  cast: ProductZkTlsPipelineV2['cast'],
  extendedPrecision = false,
): EvaluatedScalar {
  if (reduce === 'UNIQUE') {
    if (!values.length) throw new Error('PRODUCT_ZKTLS_PIPELINE_UNIQUE_EMPTY')
    if (
      values.some(
        (value) =>
          value.kind !== values[0].kind ||
          compareScalars(values[0], value) !== 0,
      )
    ) {
      throw new Error('PRODUCT_ZKTLS_PIPELINE_UNIQUE_AMBIGUOUS')
    }
    return values[0]
  }
  if (reduce === 'COUNT') {
    return {
      kind: 'INTEGER',
      value: checkedDecimal(new PreviewDecimal(values.length)),
    }
  }
  if (reduce === 'DISTINCT_COUNT') {
    const distinct: EvaluatedScalar[] = []
    for (const value of values) {
      if (!distinct.some((item) => compareScalars(item, value) === 0)) {
        distinct.push(value)
      }
    }
    return {
      kind: 'INTEGER',
      value: checkedDecimal(new PreviewDecimal(distinct.length)),
    }
  }
  if (reduce === 'SUM') return sum(values, cast, extendedPrecision)
  if (values.length === 0) return fail()
  if (reduce === 'AVG') {
    const total = sum(values, cast, extendedPrecision).value
    const average = extendedPrecision
      ? checkedDifferenceDecimal(total.div(values.length))
      : checkedDecimal(total.div(values.length))
    // V2 averages are exact fixed-point values. Rounding needs a future,
    // explicitly signed operator rather than Decimal's implicit precision.
    const multiplied = extendedPrecision
      ? checkedDifferenceDecimal(average.mul(values.length))
      : checkedDecimal(average.mul(values.length))
    if (!multiplied.eq(total)) return fail()
    return {
      kind: 'DECIMAL',
      value: average,
    }
  }
  if (reduce === 'MIN' || reduce === 'MAX') {
    let result = values[0]
    for (const value of values.slice(1)) {
      const comparison = compareScalars(value, result)
      if (
        (reduce === 'MIN' && comparison < 0) ||
        (reduce === 'MAX' && comparison > 0)
      ) {
        result = value
      }
    }
    return result
  }
  if (reduce === 'FIRST') return values[0]
  if (reduce === 'LAST') return values[values.length - 1]
  if (reduce === 'LAST_MINUS_FIRST') {
    if (values.length < 2) return fail()
    const first = numeric(values[0]).value
    const last = numeric(values[values.length - 1]).value
    const result = extendedPrecision
      ? checkedDifferenceDecimal(last.sub(first))
      : checkedDecimal(last.sub(first))
    return cast === 'INTEGER'
      ? { kind: 'INTEGER', value: result }
      : { kind: 'DECIMAL', value: result }
  }
  return fail()
}

function rejectAmbiguousOrder(rows: readonly Row[]): void {
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      const leftOrder = rows[left].order
      const rightOrder = rows[right].order
      if (
        leftOrder &&
        rightOrder &&
        compareScalars(leftOrder, rightOrder) === 0
      ) {
        fail()
      }
    }
  }
}

function reduceRows(
  rows: readonly Row[],
  reduce: NonNullable<ProductZkTlsPipelineV2['reduce']>,
  valuePath: readonly ProductJsonPathSegment[] | undefined,
  difference: ReturnType<typeof differencePaths> | undefined,
  pipeline: ProductZkTlsPipelineV2,
): EvaluatedScalar {
  if (
    reduce === 'FIRST' ||
    reduce === 'LAST' ||
    reduce === 'LAST_MINUS_FIRST'
  ) {
    rejectAmbiguousOrder(rows)
  }
  if (reduce === 'COUNT' && valuePath === undefined && !difference) {
    return {
      kind: 'INTEGER',
      value: checkedDecimal(new PreviewDecimal(rows.length)),
    }
  }
  return reduceScalars(
    selectValues(rows, valuePath, difference, pipeline),
    reduce,
    pipeline.cast,
    difference !== undefined,
  )
}

function validateUnit(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) {
    return fail()
  }
  return value
}

function output(
  value: EvaluatedScalar,
  unit?: string,
  extendedPrecision = false,
): ProductZkTlsScalar {
  if (value.kind === 'DECIMAL' || value.kind === 'INTEGER') {
    if (extendedPrecision) checkedDifferenceDecimal(value.value)
    else checkedDecimal(value.value)
    return {
      type: 'number',
      value: value.value.isZero() ? '0' : value.value.toFixed(),
      ...(unit ? { unit } : {}),
    }
  }
  if (value.kind === 'BOOLEAN') {
    return { type: 'boolean', value: value.value, ...(unit ? { unit } : {}) }
  }
  return { type: 'string', value: value.value, ...(unit ? { unit } : {}) }
}

function evaluate(
  pipeline: ProductZkTlsPipelineV2,
  response: unknown,
  variables: Readonly<Record<string, ResolvedVariable>>,
): ProductZkTlsScalar {
  selectProductJsonPath(pipeline, [])
  selectProductJsonPath(variables, [])
  selectProductJsonPath(response, [])
  for (const name of Object.keys(variables)) variable(name, variables)
  exactFields(pipeline, PIPELINE_FIELDS)
  const filterPresent = hasOwn(pipeline, 'filter')
  const orderByPresent = hasOwn(pipeline, 'orderBy')
  const groupByPresent = hasOwn(pipeline, 'groupBy')
  const valuePathPresent = hasOwn(pipeline, 'valuePath')
  const differencePresent = hasOwn(pipeline, 'difference')
  const fixedDecimalsPresent = hasOwn(pipeline, 'fixedDecimals')
  const absolutePresent = hasOwn(pipeline, 'absolute')
  const timestampPresent = hasOwn(pipeline, 'timestamp')
  const coveragePresent = hasOwn(pipeline, 'coverage')
  const reducePresent = hasOwn(pipeline, 'reduce')
  const postFilterPresent = hasOwn(pipeline, 'postFilter')
  const finalReducePresent = hasOwn(pipeline, 'finalReduce')
  const valueUnitPresent = hasOwn(pipeline, 'valueUnit')
  const outputUnitPresent = hasOwn(pipeline, 'outputUnit')
  if (
    !hasOwn(pipeline, 'output') ||
    !hasOwn(pipeline, 'sourcePath') ||
    !hasOwn(pipeline, 'cast') ||
    typeof pipeline.output !== 'string' ||
    pipeline.output.length === 0 ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(pipeline.output) ||
    !CASTS.has(pipeline.cast) ||
    (fixedDecimalsPresent &&
      (typeof pipeline.fixedDecimals !== 'number' ||
        !Number.isInteger(pipeline.fixedDecimals) ||
        pipeline.fixedDecimals < 0 ||
        pipeline.fixedDecimals > 18 ||
        (pipeline.cast !== 'DECIMAL' && pipeline.cast !== 'INTEGER'))) ||
    (absolutePresent &&
      (typeof pipeline.absolute !== 'boolean' ||
        (pipeline.cast !== 'DECIMAL' && pipeline.cast !== 'INTEGER'))) ||
    (reducePresent && !REDUCERS.has(pipeline.reduce!)) ||
    (finalReducePresent && !FINAL_REDUCERS.has(pipeline.finalReduce!))
  ) {
    return fail()
  }
  const sourcePath = path(pipeline.sourcePath)
  const sourceIsCollection = sourcePath.some(
    (segment) => segment.kind === 'COLLECTION',
  )
  const reduce = pipeline.reduce
  const finalReduce = pipeline.finalReduce
  const addressCast = pipeline.cast === 'EVM_ADDRESS_FROM_BYTES32_PREFIX'
  const reducedCast =
    reduce !== undefined
      ? reducerOutputCast(reduce, pipeline.cast)
      : pipeline.cast
  const valuePath = valuePathPresent ? path(pipeline.valuePath) : undefined
  const difference = differencePresent
    ? differencePaths(pipeline.difference)
    : undefined
  const valueUnit = valueUnitPresent
    ? validateUnit(pipeline.valueUnit)
    : undefined
  const outputUnit = outputUnitPresent
    ? validateUnit(pipeline.outputUnit)
    : undefined
  let orderPath: readonly ProductJsonPathSegment[] | undefined
  const orderBy = pipeline.orderBy
  if (orderByPresent) {
    if (orderBy === undefined) return fail()
    exactObjectFields(orderBy, ['path', 'direction'])
    if (orderBy.direction !== 'ASC' && orderBy.direction !== 'DESC') {
      return fail()
    }
    orderPath = path(orderBy.path)
  }
  let timestampDeclaration:
    | NonNullable<ProductZkTlsPipelineV2['timestamp']>
    | undefined
  if (timestampPresent) {
    if (pipeline.timestamp === undefined) return fail()
    exactObjectFields(pipeline.timestamp, ['path', 'format'])
    if (
      pipeline.timestamp.format !== 'ISO_8601' &&
      pipeline.timestamp.format !== 'UNIX_SECONDS' &&
      pipeline.timestamp.format !== 'UNIX_MILLISECONDS'
    ) {
      return fail()
    }
    path(pipeline.timestamp.path)
    timestampDeclaration = pipeline.timestamp
  }
  if (coveragePresent) {
    if (pipeline.coverage === undefined) return fail()
    exactObjectFields(pipeline.coverage, ['kind', 'requestLimit'])
    if (
      pipeline.coverage.kind !== 'DESCENDING_WINDOW' ||
      !Number.isInteger(pipeline.coverage.requestLimit) ||
      pipeline.coverage.requestLimit < 1 ||
      pipeline.coverage.requestLimit > 200 ||
      !timestampDeclaration ||
      pipeline.orderBy?.direction !== 'DESC' ||
      pipeline.orderBy.path !== timestampDeclaration.path
    ) {
      return fail()
    }
  }
  let groupPath: readonly ProductJsonPathSegment[] | undefined
  const groupBy = pipeline.groupBy
  if (groupByPresent) {
    if (groupBy === undefined) return fail()
    exactObjectFields(groupBy, ['path', 'interval'])
    if (groupBy.interval !== 'UTC_DAY') return fail()
    groupPath = path(groupBy.path)
  }
  const filter = pipeline.filter
  if (filterPresent) {
    if (filter === undefined) return fail()
    validatePredicateDefinition(filter, variables, { leaves: 0 })
  }
  const postFilter = pipeline.postFilter
  if (postFilterPresent) {
    if (postFilter === undefined) return fail()
    validateScalarPredicateDefinition(postFilter, variables, reducedCast)
  }
  if (
    (addressCast &&
      ((sourceIsCollection && reduce !== 'UNIQUE') ||
        (filterPresent && !sourceIsCollection) ||
        orderByPresent ||
        groupByPresent ||
        (valuePathPresent && !sourceIsCollection) ||
        differencePresent ||
        (reducePresent && reduce !== 'UNIQUE') ||
        postFilterPresent ||
        finalReducePresent ||
        valueUnitPresent ||
        outputUnitPresent)) ||
    ((filterPresent || orderByPresent || groupByPresent || reducePresent) &&
      !sourceIsCollection) ||
    (sourceIsCollection && !reducePresent) ||
    (differencePresent &&
      (valuePathPresent ||
        (pipeline.cast !== 'DECIMAL' && pipeline.cast !== 'INTEGER'))) ||
    (reduce !== undefined &&
      reduce !== 'COUNT' &&
      !valuePathPresent &&
      !differencePresent) ||
    (reduce !== undefined && !reducerSupports(reduce, pipeline.cast)) ||
    ((reduce === 'FIRST' ||
      reduce === 'LAST' ||
      reduce === 'LAST_MINUS_FIRST') &&
      !orderByPresent) ||
    (groupByPresent && reduce === undefined) ||
    (postFilterPresent && !groupByPresent) ||
    (finalReducePresent && !groupByPresent) ||
    (groupByPresent && !finalReducePresent) ||
    (finalReduce !== undefined && !reducerSupports(finalReduce, reducedCast)) ||
    (!finalReducePresent && valueUnit !== outputUnit) ||
    (finalReduce !== undefined &&
      finalReduce !== 'COUNT' &&
      valueUnit !== outputUnit) ||
    ((reduce === 'COUNT' || reduce === 'DISTINCT_COUNT') &&
      !COUNT_UNITS.has(valueUnit ?? '')) ||
    (finalReduce === 'COUNT' && !COUNT_UNITS.has(outputUnit ?? '')) ||
    (postFilterPresent && pipeline.postFilter?.unit !== valueUnit)
  ) {
    return fail()
  }

  const source = selectProductJsonPath(response, sourcePath)
  if (!sourceIsCollection) {
    const result = difference
      ? subtractFields(source[0], difference, pipeline)
      : castPipelineScalar(
          valuePath ? singleSelection(source[0], valuePath) : source[0],
          pipeline,
        )
    return output(result, outputUnit, differencePresent)
  }

  if (pipeline.coverage) {
    if (source.length > pipeline.coverage.requestLimit) return fail()
    const instants = source.map((value) =>
      declaredTimestamp(
        singleSelection(value, path(timestampDeclaration!.path)),
        timestampDeclaration!.format,
      ),
    )
    for (let index = 1; index < instants.length; index += 1) {
      if (compareScalars(instants[index]!, instants[index - 1]!) > 0) {
        return fail()
      }
    }
    if (source.length === pipeline.coverage.requestLimit) {
      const periodStart = variable('periodStart', variables)
      if (periodStart.kind !== 'UTC_TIMESTAMP') return fail()
      const oldest = instants.at(-1)
      if (!oldest) return fail()
      if (compareScalars(oldest, periodStart) > 0) {
        throw new ProductZkTlsInsufficientDataError()
      }
    }
  }

  let rows: Row[] = source.map((value) => ({ value }))
  if (filterPresent) {
    rows = rows.filter((value) =>
      predicate(pipeline.filter!, value.value, variables, { leaves: 0 }),
    )
  }
  if (reduce === 'UNIQUE' && rows.length === 0) {
    throw new Error('PRODUCT_ZKTLS_PIPELINE_UNIQUE_EMPTY')
  }
  if (orderByPresent) {
    rows = rows.map((row) => ({
      ...row,
      order: inferScalar(singleSelection(row.value, orderPath!)),
    }))
    const direction = orderBy!.direction === 'ASC' ? 1 : -1
    rows.sort(
      (left, right) => direction * compareScalars(left.order!, right.order!),
    )
  }

  let groups: Row[][]
  if (groupByPresent) {
    const grouped = new Map<string, Row[]>()
    for (const row of rows) {
      const selected = singleSelection(row.value, groupPath!)
      const instant =
        timestampDeclaration?.path === groupBy!.path
          ? declaredTimestamp(selected, timestampDeclaration.format)
          : timestamp(selected)
      if (instant.kind !== 'UTC_TIMESTAMP') return fail()
      const day = instant.value.slice(0, 10)
      const values = grouped.get(day) ?? []
      values.push(row)
      grouped.set(day, values)
    }
    groups = [...grouped.values()]
  } else {
    groups = [rows]
  }

  let reduced = groups.map((group) =>
    reduceRows(group, reduce!, valuePath, difference, pipeline),
  )
  if (postFilterPresent) {
    reduced = reduced.filter((value) =>
      scalarPredicate(pipeline.postFilter!, value, variables),
    )
  }
  const result =
    finalReduce !== undefined
      ? reduceScalars(reduced, finalReduce, reducedCast, differencePresent)
      : reduced.length === 1
        ? reduced[0]
        : fail()
  return output(result, outputUnit, differencePresent)
}

export function evaluateProductZkTlsPipeline(
  pipeline: ProductZkTlsPipelineV2,
  response: unknown,
  variables: Readonly<Record<string, ResolvedVariable>>,
): ProductZkTlsScalar {
  try {
    return evaluate(pipeline, response, variables)
  } catch (error) {
    if (
      error instanceof Error &&
      /^PRODUCT_ZKTLS_PIPELINE_UNIQUE_(EMPTY|AMBIGUOUS)$/.test(error.message)
    )
      throw error
    return fail()
  }
}

/** Distinguish an empty signed source/filter from a legitimate computed zero. */
export function hasProductZkTlsPreviewRows(
  pipeline: ProductZkTlsPipelineV2,
  response: unknown,
  variables: Readonly<Record<string, ResolvedVariable>>,
): boolean {
  const source = selectProductJsonPath(response, path(pipeline.sourcePath))
  return source.some(
    (value) =>
      !pipeline.filter ||
      predicate(pipeline.filter, value, variables, { leaves: 0 }),
  )
}
