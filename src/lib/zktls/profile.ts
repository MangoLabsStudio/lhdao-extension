type PublicKeys = Record<string, JsonWebKey>

export type ZkTlsProfile = {
  enabled: boolean
  local: boolean
  apiEndpoint: string | null
  verifierEndpoint: string | null
  publicKeys: PublicKeys
}

declare const __ZKTLS_PROFILE__: ZkTlsProfile

export const ZKTLS_PROFILE: ZkTlsProfile =
  typeof __ZKTLS_PROFILE__ === 'undefined'
    ? {
        enabled: false,
        local: false,
        apiEndpoint: null,
        verifierEndpoint: null,
        publicKeys: {},
      }
    : __ZKTLS_PROFILE__
export const ZKTLS_VERIFICATION_PATH = '/verify/'

export function zktlsVerificationPath(sessionId: string): string {
  return `${ZKTLS_VERIFICATION_PATH}${sessionId}`
}

export function isSupportedZkTlsBrowser(): boolean {
  return ZKTLS_PROFILE.enabled && !/firefox/i.test(navigator.userAgent)
}
