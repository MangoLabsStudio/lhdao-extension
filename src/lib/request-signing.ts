import { canonicalJson, sha256Hex } from './canonical-json'
import type { PluginOperationDefinition } from './plugin-operations'

export interface PluginSignatureMessageInput {
  operationId: string
  documentSha256: string
  variablesSha256: string
  deviceId: string
  timestamp: string
  nonce: string
}

interface SignPluginRequestInput {
  operation: PluginOperationDefinition
  variables: unknown
  deviceId: string
  privateKey: CryptoKey
  timestamp?: string
  nonce?: string
}

export function buildPluginSignatureMessage(
  input: PluginSignatureMessageInput,
): string {
  return [
    'lhdao-plugin-v1',
    input.operationId,
    input.documentSha256,
    input.variablesSha256,
    input.deviceId,
    input.timestamp,
    input.nonce,
  ].join('\n')
}

export async function signPluginRequest(input: SignPluginRequestInput) {
  const timestamp = input.timestamp ?? String(Date.now())
  const nonce = input.nonce ?? randomNonce()
  const variablesSha256 = await sha256Hex(canonicalJson(input.variables ?? {}))
  const message = buildPluginSignatureMessage({
    operationId: input.operation.id,
    documentSha256: input.operation.documentSha256,
    variablesSha256,
    deviceId: input.deviceId,
    timestamp,
    nonce,
  })
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    input.privateKey,
    new TextEncoder().encode(message),
  )
  return {
    message,
    headers: {
      'x-plugin-operation-id': input.operation.id,
      'x-device-id': input.deviceId,
      'x-request-timestamp': timestamp,
      'x-request-nonce': nonce,
      'x-device-signature': toBase64Url(new Uint8Array(signature)),
    },
  }
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return toBase64Url(bytes)
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}
