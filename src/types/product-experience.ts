export type ProductTicketKind = 'PARTICIPANT' | 'TEST'
export type ProductExperienceEvaluationMode = 'STRICT' | 'SELECTOR_ONLY'

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
  rules: ProductExperienceRule[]
}
