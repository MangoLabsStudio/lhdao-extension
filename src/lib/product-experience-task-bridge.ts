import type { MsgRequest } from '../types/messages'
import type { ProductExperienceTaskRef } from '../types/product-experience'

export const PRODUCT_EXPERIENCE_PAGE_CHANNEL = 'product-experience-v1' as const
export const PRODUCT_EXPERIENCE_CAPABILITY = 'product-experience-v1' as const

const MAX_CORRELATION_ID_LENGTH = 128
const MAX_CAMPAIGN_ID_LENGTH = 128
const MAX_TITLE_LENGTH = 256
const MAX_RULE_ID_LENGTH = 128
const MAX_RULE_COUNT = 20

export type ProductExperiencePageRequest =
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
}

export interface PublicProductExperienceState {
  campaignId: string
  status: ProductExperiencePublicStatus
  matchedRuleIds: string[]
  totalRuleCount: number
  authorizationRequired: boolean
  currentOriginAllowed: boolean
  version: string
  capabilities: [typeof PRODUCT_EXPERIENCE_CAPABILITY]
  error: ProductExperiencePublicError | null
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
    const value: unknown = event.data
    if (
      !isRecord(value) ||
      value.channel !== PRODUCT_EXPERIENCE_PAGE_CHANNEL ||
      !isCorrelationId(value.correlationId)
    ) {
      return null
    }

    if (value.type === 'save-product-experience-task') {
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

    if (value.type === 'start-discovery') {
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
        type: value.type,
        correlationId: value.correlationId,
        targetUrl: value.targetUrl,
      }
    }

    if (
      value.type === 'stop-discovery' ||
      value.type === 'get-discovery-snapshot'
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
        type: value.type,
        correlationId: value.correlationId,
        sessionId: value.sessionId,
      }
    }

    if (value.type === 'get-public-product-experience-state') {
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
    capabilities: [PRODUCT_EXPERIENCE_CAPABILITY],
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
    capabilities: [PRODUCT_EXPERIENCE_CAPABILITY],
    error: currentState.error,
  }
}
