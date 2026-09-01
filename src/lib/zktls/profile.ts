type PublicKeys = Record<string, JsonWebKey>

export type ZkTlsProfile = {
  enabled: boolean
  debug: boolean
  local: boolean
  apiEndpoint: string | null
  verifierEndpoint: string | null
  verifierProfileId: string | null
  publicKeys: PublicKeys
}

declare const __ZKTLS_PROFILE__: ZkTlsProfile

export const ZKTLS_PROFILE: ZkTlsProfile =
  typeof __ZKTLS_PROFILE__ === 'undefined'
    ? {
        enabled: false,
        debug: false,
        local: false,
        apiEndpoint: null,
        verifierEndpoint: null,
        verifierProfileId: null,
        publicKeys: {},
      }
    : __ZKTLS_PROFILE__
export const ZKTLS_VERIFICATION_PATH = '/verify/'

export function zktlsVerificationPath(sessionId: string): string {
  return `${ZKTLS_VERIFICATION_PATH}${sessionId}`
}

export function assertVerifierProfile(config: {
  verifier_profile_id: string
}): void {
  if (
    !ZKTLS_PROFILE.verifierProfileId ||
    config.verifier_profile_id !== ZKTLS_PROFILE.verifierProfileId
  )
    throw new Error('connector verifier profile is unavailable')
}

export function isSupportedZkTlsBrowser(): boolean {
  return ZKTLS_PROFILE.enabled && !/firefox/i.test(navigator.userAgent)
}
