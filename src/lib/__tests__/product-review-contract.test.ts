import { expect, test } from 'vitest'
import { parseStartProductZkTlsTestProofResult } from '../queries'

test('reads trusted review wallet without inferring it for old sessions', () => {
  const session = {
    sessionId: 's',
    connectorId: 'c',
    expiresAt: '2026-09-11T00:00:00.000Z',
  }
  const wallet = '0x1111111111111111111111111111111111111111'
  expect(
    parseStartProductZkTlsTestProofResult({
      startProductZkTlsTestProof: { ...session, reviewWalletAddress: wallet },
    }).startProductZkTlsTestProof.reviewWalletAddress,
  ).toBe(wallet)
  expect(
    parseStartProductZkTlsTestProofResult({
      startProductZkTlsTestProof: session,
    }).startProductZkTlsTestProof.reviewWalletAddress,
  ).toBeUndefined()
})
