import type { MsgRequest } from '../types/messages'
import type { ProductExperienceTaskRef } from '../types/product-experience'
import type { ProductZkTlsCondition } from './product-experience-controller'

export const PRODUCT_EXPERIENCE_PAGE_CHANNEL = 'product-experience-v1' as const
export const PRODUCT_EXPERIENCE_CAPABILITY = 'product-experience-v1' as const
export const PRODUCT_EXPERIENCE_CAPABILITIES = [
  PRODUCT_EXPERIENCE_CAPABILITY,
  'product-zktls-discovery-v1',
  'product-zktls-execution-v1',
] as const

const MAX_CORRELATION_ID_LENGTH = 128
const MAX_CAMPAIGN_ID_LENGTH = 128
const MAX_TITLE_LENGTH = 256
const MAX_RULE_ID_LENGTH = 128
const MAX_RULE_COUNT = 20

export type ProductExperiencePageRequest =
  | {
      channel: typeof PRODUCT_EXPERIENCE_PAGE_CHANNEL
      type: 'retry-product-experience-rule'
      correlationId: string
      campaignId: string
      ruleId: string
    }
  | (Extract<
      MsgRequest,
      { type: 'start-discovery' | 'stop-discovery' | 'get-discovery-snapshot' }
    > & {
      channel: typeof PRODUCT_EXPERIENCE_PAGE_CHANNEL
    })
  | {
      channel: typeof PRODUCT_EXPERIENCE_PAGE_CHANNEL
      type: 'save-product-experience-task'
      correlationId: string
      task: ProductExperienceTaskRef
    }
  | {
      channel: typeof PRODUCT_EXPERIENCE_PAGE_CHANNEL
      type: 'get-public-product-experience-state'
      correlationId: string
      campaignId: string
    }

export type ProductExperiencePublicStatus =
  | 'idle'
  | 'ready'
  | 'authorizing'
  | 'observing'
  | 'submitting'
  | 'verified'
  | 'expired'
  | 'origin-mismatch'
  | 'reauthorize'
  | 'error'

export type ProductExperiencePublicError =
  | 'AUTHORIZATION_REQUIRED'
  | 'EXTENSION_ERROR'
  | 'ORIGIN_NOT_ALLOWED'
  | 'SESSION_EXPIRED'
  | 'VERSION_MISMATCH'
  | 'VERIFICATION_FAILED'

export interface ProductExperiencePublicStateSource {
  campaignId: string
  status: ProductExperiencePublicStatus
  matchedRuleIds: readonly string[]
  totalRuleCount: number
  authorizationRequired: boolean
  currentOriginAllowed: boolean
  error: ProductExperiencePublicError | null
  conditions?: ProductZkTlsCondition[]
  finished?: boolean
  testPassed?: boolean
}

export interface PublicProductExperienceState {
  campaignId: string
  status: ProductExperiencePublicStatus
  matchedRuleIds: string[]
  totalRuleCount: number
  authorizationRequired: boolean
  currentOriginAllowed: boolean
  version: string
  capabilities: Array<(typeof PRODUCT_EXPERIENCE_CAPABILITIES)[number]>
  error: ProductExperiencePublicError | null
  conditions?: ProductZkTlsCondition[]
  finished?: boolean
  testPassed?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort()
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys
      .slice()
      .sort()
      .every((key, index) => actualKeys[index] === key)
  )
}

function isCorrelationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= MAX_CORRELATION_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

function isCampaignId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CAMPAIGN_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

export function parseProductRuleRetry(
  value: unknown,
): Extract<MsgRequest, { type: 'retry-product-experience-rule' }> | null {
  if (
    !isRecord(value) ||
    value.type !== 'retry-product-experience-rule' ||
    !hasExactKeys(value, [
      'type',
      'campaignId',
      'ruleId',
      ...(value.correlationId === undefined ? [] : ['correlationId']),
    ]) ||
    !isCampaignId(value.campaignId) ||
    typeof value.ruleId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(value.ruleId) ||
    (value.correlationId !== undefined && !isCorrelationId(value.correlationId))
  )
    return null
  return {
    type: 'retry-product-experience-rule',
    campaignId: value.campaignId,
    ruleId: value.ruleId,
    ...(value.correlationId === undefined
      ? {}
      : { correlationId: value.correlationId }),
  }
}

function isDiscoveryTargetUrl(value: unknown): value is string {
  if (!isSafeText(value, 2048)) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.href === value || url.origin === value)
    )
  } catch {
    return false
  }
}

export type DiscoveryRequest = Extract<
  MsgRequest,
  { type: 'start-discovery' | 'stop-discovery' | 'get-discovery-snapshot' }
>

/** The runtime boundary repeats the page validation; sender supplies all tab IDs. */
export function parseDiscoveryRequest(input: unknown): DiscoveryRequest | null {
  try {
    if (!isRecord(input)) return null
    const type = Object.getOwnPropertyDescriptor(input, 'type')?.value
    if (
      !['start-discovery', 'stop-discovery', 'get-discovery-snapshot'].includes(
        type,
      )
    )
      return null
    const proto = Object.getPrototypeOf(input)
    if (proto !== Object.prototype && proto !== null) return null
    const keys = [
      'type',
      'correlationId',
      type === 'start-discovery' ? 'targetUrl' : 'sessionId',
    ]
    if (Reflect.ownKeys(input).length !== keys.length) return null
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !keys.includes(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      if (
        !descriptor?.enumerable ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string'
      )
        return null
    }
    const value = structuredClone(input)
    if (!isCorrelationId(value.correlationId)) return null
    if (
      type === 'start-discovery'
        ? !isDiscoveryTargetUrl(value.targetUrl)
        : !isCampaignId(value.sessionId)
    )
      return null
    return value as DiscoveryRequest
  } catch {
    return null
  }
}

function discoverySnapshot(
  value: Record<string, unknown>,
  operation: string,
): Record<string, unknown> | null {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const fields = [
    'channel',
    'type',
    'correlationId',
    operation === 'start-discovery' ? 'targetUrl' : 'sessionId',
  ]
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== fields.length) return null
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !fields.includes(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !descriptor?.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    )
      return null
  }
  // Clone the original only after rejecting accessors; structuredClone rejects proxies.
  return structuredClone(value)
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !hasControlCharacters(value)
  )
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return true
  }
  return false
}

function parseTaskRef(value: unknown): ProductExperienceTaskRef | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'campaignId',
      'configVersion',
      'savedAt',
      'ticketKind',
      'title',
    ]) ||
    !isCampaignId(value.campaignId) ||
    (value.ticketKind !== 'PARTICIPANT' && value.ticketKind !== 'TEST') ||
    !Number.isSafeInteger(value.configVersion) ||
    (value.configVersion as number) <= 0 ||
    (value.configVersion as number) > 2_147_483_647 ||
    !isSafeText(value.title, MAX_TITLE_LENGTH) ||
    !Number.isSafeInteger(value.savedAt) ||
    (value.savedAt as number) <= 0
  ) {
    return null
  }

  return {
    campaignId: value.campaignId,
    ticketKind: value.ticketKind,
    configVersion: value.configVersion as number,
    title: value.title,
    savedAt: value.savedAt as number,
  }
}

export function parseProductExperiencePageRequest(
  event: MessageEvent,
  expectedSource: Window,
  expectedOrigin: string,
): ProductExperiencePageRequest | null {
  if (event.source !== expectedSource || event.origin !== expectedOrigin) {
    return null
  }

  try {
    let value: unknown = event.data
    if (!isRecord(value)) return null
    const operation: unknown = Object.getOwnPropertyDescriptor(
      value,
      'type',
    )?.value
    if (typeof operation !== 'string') return null
    if (
      operation === 'start-discovery' ||
      operation === 'stop-discovery' ||
      operation === 'get-discovery-snapshot'
    ) {
      value = discoverySnapshot(value, operation)
    }
    if (
      !isRecord(value) ||
      value.channel !== PRODUCT_EXPERIENCE_PAGE_CHANNEL ||
      !isCorrelationId(value.correlationId)
    ) {
      return null
    }

    if (operation === 'save-product-experience-task') {
      if (!hasExactKeys(value, ['channel', 'correlationId', 'task', 'type'])) {
        return null
      }
      const task = parseTaskRef(value.task)
      if (!task) return null
      return {
        channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
        type: 'save-product-experience-task',
        correlationId: value.correlationId,
        task,
      }
    }

    if (operation === 'retry-product-experience-rule') {
      const { channel: _channel, ...runtime } = value
      const parsed = parseProductRuleRetry(runtime)
      return parsed?.correlationId
        ? {
            ...parsed,
            channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
            correlationId: parsed.correlationId,
          }
        : null
    }

    if (operation === 'start-discovery') {
      if (
        !hasExactKeys(value, [
          'channel',
          'correlationId',
          'targetUrl',
          'type',
        ]) ||
        !isDiscoveryTargetUrl(value.targetUrl)
      )
        return null
      return {
        channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
        type: operation,
        correlationId: value.correlationId,
        targetUrl: value.targetUrl,
      }
    }

    if (
      operation === 'stop-discovery' ||
      operation === 'get-discovery-snapshot'
    ) {
      if (
        !hasExactKeys(value, [
          'channel',
          'correlationId',
          'sessionId',
          'type',
        ]) ||
        !isCampaignId(value.sessionId)
      )
        return null
      return {
        channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
        type: operation,
        correlationId: value.correlationId,
        sessionId: value.sessionId,
      }
    }

    if (operation === 'get-public-product-experience-state') {
      if (
        !hasExactKeys(value, [
          'campaignId',
          'channel',
          'correlationId',
          'type',
        ]) ||
        !isCampaignId(value.campaignId)
      ) {
        return null
      }
      return {
        channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
        type: 'get-public-product-experience-state',
        correlationId: value.correlationId,
        campaignId: value.campaignId,
      }
    }
  } catch {
    return null
  }

  return null
}

function idleState(
  campaignId: string,
  version: string,
): PublicProductExperienceState {
  return {
    campaignId,
    status: 'idle',
    matchedRuleIds: [],
    totalRuleCount: 0,
    authorizationRequired: false,
    currentOriginAllowed: false,
    version,
    capabilities: [...PRODUCT_EXPERIENCE_CAPABILITIES],
    error: null,
  }
}

function sanitizeRuleIds(ruleIds: readonly string[]): string[] {
  const sanitized = new Set<string>()
  for (const ruleId of ruleIds) {
    if (
      typeof ruleId === 'string' &&
      ruleId.length > 0 &&
      ruleId.length <= MAX_RULE_ID_LENGTH &&
      !hasControlCharacters(ruleId)
    ) {
      sanitized.add(ruleId)
    }
  }
  return [...sanitized]
}

export function projectPublicProductExperienceState(
  requestedCampaignId: string,
  currentState: ProductExperiencePublicStateSource | null,
  extensionVersion: string,
): PublicProductExperienceState {
  const version = isSafeText(extensionVersion, 64) ? extensionVersion : '0'
  if (!currentState || currentState.campaignId !== requestedCampaignId) {
    return idleState(requestedCampaignId, version)
  }

  return {
    campaignId: requestedCampaignId,
    status: currentState.status,
    matchedRuleIds: sanitizeRuleIds(currentState.matchedRuleIds),
    totalRuleCount:
      Number.isInteger(currentState.totalRuleCount) &&
      currentState.totalRuleCount >= 0 &&
      currentState.totalRuleCount <= MAX_RULE_COUNT
        ? currentState.totalRuleCount
        : 0,
    authorizationRequired: currentState.authorizationRequired,
    currentOriginAllowed: currentState.currentOriginAllowed,
    version,
    capabilities: [...PRODUCT_EXPERIENCE_CAPABILITIES],
    error: currentState.error,
    ...(currentState.conditions
      ? {
          conditions: currentState.conditions
            .slice(0, MAX_RULE_COUNT)
            .map((condition) => ({
              ruleId: condition.ruleId,
              ...(condition.title ? { title: condition.title } : {}),
              status: condition.status,
              code: condition.code,
              stage: condition.stage,
              correlationId: condition.correlationId,
              ...(condition.details
                ? {
                    details: condition.details
                      .slice(0, 32)
                      .map(({ category, pointer }) => ({ category, pointer })),
                  }
                : {}),
              ...(condition.status === 'verified_no'
                ? {
                    actual: condition.actual,
                    required: condition.required,
                    comparator: condition.comparator,
                  }
                : {}),
            })),
          finished: currentState.finished === true,
          testPassed: currentState.testPassed === true,
        }
      : {}),
  }
}
