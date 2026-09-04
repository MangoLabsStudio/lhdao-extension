export type ProductTicketKind = 'PARTICIPANT' | 'TEST'
export type ProductExperienceEvaluationMode = 'STRICT' | 'SELECTOR_ONLY'
export type ProductExperienceVerificationMode = 'LEGACY_DOM' | 'ZKTLS'
export type ProductZkTlsProgressStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PARTIAL'
  | 'INSUFFICIENT_DATA'
  | 'VERIFIED'
  | 'VERIFIED_NO'
export type ProductZkTlsScalar = boolean | number | string | null

export interface ProductZkTlsDiagnosticEvent {
  at: number
  stage: string
  status: 'running' | 'passed' | 'failed'
  details?: unknown
  error?: unknown
}

export interface ProductZkTlsDiagnostic {
  correlationId: string
  startedAt: number
  updatedAt: number
  events: ProductZkTlsDiagnosticEvent[]
}

export interface ProductExperienceTaskRef {
  campaignId: string
  ticketKind: ProductTicketKind
  configVersion: number
  title: string
  savedAt: number
}

export type ProductExperienceCondition =
  | { type: 'ELEMENT_EXISTS' }
  | { type: 'TEXT_CONTAINS'; expected: string }
  | {
      type: 'ATTRIBUTE_EQUALS'
      attributeName: string
      expected: string
    }
  | { type: 'COUNT_AT_LEAST'; minimumCount: number }
  | { type: 'NUMERIC_AT_LEAST'; minimumValue: number }

export interface ProductExperienceRule {
  id: string
  title: string
  urlPattern: string
  selector: string
  condition: ProductExperienceCondition
}

export interface ProductRuleMatch {
  ruleId: string
  matchedAt: string
  origin: string
  urlPathHash: string
}

export interface ProductExperienceTicket {
  ticket: string
  macKey: string
  expiresAt: string
  ruleSetVersion: number
  allowedOrigins: string[]
  completionMode: 'ALL'
  verificationMode: ProductExperienceVerificationMode
  rules: ProductExperienceRule[]
}

export interface ProductZkTlsSession {
  sessionId: string
  connectorId: string
  expiresAt: string
  executionPlan?: ProductZkTlsExecutionPlan | null
}

export interface ProductZkTlsExecutionPlan {
  version: 1
  steps: Array<{
    connectorId: string
    triggerPaths: string[]
    dependentFactIds: string[]
    dependentRuleIds: string[]
  }>
}

export interface ProductIntegrationCheck {
  configVersion: number
  experiencePassed: boolean
  experiencePassedAt: string | null
}

export interface ProductZkTlsRuleProgress {
  ruleId: string
  title: string
  status: ProductZkTlsProgressStatus
  current: ProductZkTlsScalar
  target: ProductZkTlsScalar
  unit: string | null
  actual?: ProductZkTlsScalar
  required?: ProductZkTlsScalar
  comparator?: string | null
}
