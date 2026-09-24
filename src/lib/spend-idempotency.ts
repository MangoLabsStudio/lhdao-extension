import { canonicalJson } from './canonical-json'

const pendingSpendKeys = new Map<string, string>()

export function spendActionKey(scope: string, variables: unknown): string {
  const fingerprint = `${scope}:${canonicalJson(variables ?? {})}`
  const existing = pendingSpendKeys.get(fingerprint)
  if (existing) return existing
  const key = `${scope}:${randomId()}`
  pendingSpendKeys.set(fingerprint, key)
  return key
}

export function releaseSpendActionKey(scope: string, variables: unknown): void {
  pendingSpendKeys.delete(`${scope}:${canonicalJson(variables ?? {})}`)
}

export function releaseSpendActionKeyAfterDefiniteFailure(
  scope: string,
  variables: unknown,
  error: { httpStatus?: number; uncertain: boolean },
): boolean {
  if (error.httpStatus === undefined || error.uncertain) return false
  releaseSpendActionKey(scope, variables)
  return true
}

export function childSpendActionKey(
  parentKey: string,
  childId: string,
): string {
  return `${parentKey}:${childId}`.slice(0, 128)
}

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(
    '',
  )
}
