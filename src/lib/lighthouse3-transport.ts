import { sha256Hex } from './canonical-json'
import { getOrCreateDeviceIdentity } from './device-key'
import { signPluginRequest } from './request-signing'
import { localStore } from './storage'

/** Explicit build profile only; existing production/beta GraphQL builds stay unchanged. */
export function isLighthouse3Endpoint(endpoint: string): boolean {
  return endpoint === 'https://app.lhdaobeta.top/lighthouse3.0/api/v3'
}

export function pairingPage(
  webEndpoint: string,
  code: string,
  v3: boolean,
): string {
  return `${webEndpoint}/extension/connect${v3 ? '#' : '?'}code=${encodeURIComponent(code)}`
}

export class Lighthouse3Error extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus?: number,
  ) {
    super(code)
  }
}

export async function lighthouse3Post(
  endpoint: string,
  path: string,
  input: unknown,
  options: {
    signal?: AbortSignal
    operation?: {
      id: string
      name: string
      document: string
      variables: unknown
    }
  } = {},
): Promise<unknown> {
  if (!isLighthouse3Endpoint(endpoint))
    throw new Lighthouse3Error('LH3_ENDPOINT_DENIED')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.operation) {
    const token = await localStore.get('apiToken')
    if (!token) throw new Lighthouse3Error('PLUGIN_NOT_CONNECTED')
    const device = await getOrCreateDeviceIdentity()
    const op = options.operation
    const signed = await signPluginRequest({
      operation: {
        id: op.id,
        operationName: op.name,
        document: op.document,
        documentSha256: await sha256Hex(op.document),
        permission: 'read',
        version: 1,
      },
      variables: op.variables,
      deviceId: device.deviceId,
      privateKey: device.privateKey,
    })
    Object.assign(headers, signed.headers, { authorization: `Bearer ${token}` })
  } else if (!['plugin/pairings', 'plugin/pairings/poll'].includes(path)) {
    throw new Lighthouse3Error('PLUGIN_SECURITY_REQUIRED')
  }
  if (!/^[A-Za-z0-9_/-]+$/.test(path) || path.includes('..'))
    throw new Lighthouse3Error('LH3_PATH_DENIED')
  const response = await fetch(`${endpoint}/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: options.signal,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  })
  const text = await response.text()
  if (text.length > 1048576)
    throw new Lighthouse3Error('LH3_RESPONSE_TOO_LARGE')
  let body: { data?: unknown; code?: string }
  try {
    body = JSON.parse(text)
  } catch {
    throw new Lighthouse3Error('LH3_RESPONSE_INVALID', response.status)
  }
  if (!response.ok)
    throw new Lighthouse3Error(body.code ?? 'LH3_HTTP_ERROR', response.status)
  if (!Object.hasOwn(body, 'data'))
    throw new Lighthouse3Error('LH3_RESPONSE_INVALID', response.status)
  return body.data
}

export async function lighthouse3Pairing(
  endpoint: string,
  operation: string,
  variables: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (operation === 'CreateExtensionPairing') {
    await lighthouse3Post(endpoint, 'plugin/pairings', variables, { signal })
    return { createExtensionPairing: true }
  }
  if (operation === 'PollExtensionPairing') {
    const result = await lighthouse3Post(
      endpoint,
      'plugin/pairings/poll',
      variables,
      { signal },
    )
    return { pollExtensionPairing: result }
  }
  throw new Lighthouse3Error('LH3_OPERATION_NOT_CONNECTED')
}

type V3Task = {
  id: string
  acceptedReceiptId: string
  acceptedRewardLux: string
  penaltyDivisor: string
  [key: string]: unknown
}
type V3Snapshot = { scope: 'OWN_RESERVED_LIKE'; me: unknown; tasks: V3Task[] }
async function received(
  endpoint: string,
  signal?: AbortSignal,
): Promise<V3Snapshot> {
  const result = (await lighthouse3Post(
    endpoint,
    'plugin/received-tasks',
    {},
    {
      signal,
      operation: {
        id: 'lh3.received.read.v1',
        name: 'ReadOwnPluginReceivedTasks',
        document: 'POST /api/v3/plugin/received-tasks',
        variables: { acceptedReceiptId: 'self', input: {} },
      },
    },
  )) as V3Snapshot
  if (result?.scope !== 'OWN_RESERVED_LIKE' || !Array.isArray(result.tasks))
    throw new Lighthouse3Error('LH3_RESPONSE_INVALID')
  return result
}
async function likeRequest(
  endpoint: string,
  receiptId: string,
  kind: 'context' | 'ticket' | 'submit',
  input: unknown,
  signal?: AbortSignal,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(receiptId))
    throw new Lighthouse3Error('LH3_RECEIPT_INVALID')
  const suffix = kind === 'submit' ? 'verification' : kind
  return lighthouse3Post(
    endpoint,
    `dispatch/acceptances/${receiptId}/like-${suffix}`,
    input,
    {
      signal,
      operation: {
        id: `lh3.like.${kind}.v1`,
        name:
          kind === 'context'
            ? 'ReadOwnPluginLikeTask'
            : kind === 'ticket'
              ? 'MintLikeEngagementTicket'
              : 'SubmitLikeVerification',
        document: `POST /api/v3/dispatch/acceptances/:acceptedReceiptId/like-${suffix}`,
        variables: { acceptedReceiptId: receiptId, input },
      },
    },
  )
}

async function pendingKey(campaignId: string) {
  const token = await localStore.get('apiToken')
  if (!token) throw new Lighthouse3Error('PLUGIN_NOT_CONNECTED')
  return `lh3-pending:${await sha256Hex(token)}:${campaignId}`
}

/** Reuse the exact command after an uncertain response, including its original proof. */
export async function resumeLighthouse3Proof(
  endpoint: string,
  campaignId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const key = await pendingKey(campaignId)
  const pending = (await chrome.storage.local.get(key))[key] as
    | {
        receiptId: string
        input: {
          requestKey: string
          deviceId: string
          proof: { campaignId: string }
        }
      }
    | undefined
  if (!pending) return false
  if (pending.input.proof.campaignId !== campaignId)
    throw new Lighthouse3Error('LH3_RECEIPT_MISMATCH')
  const result = (await likeRequest(
    endpoint,
    pending.receiptId,
    'submit',
    pending.input,
    signal,
  )) as { status: string; requestKey: string; campaignId: string }
  if (
    result?.status !== 'VERIFYING' ||
    result.requestKey !== pending.input.requestKey ||
    result.campaignId !== campaignId
  )
    throw new Lighthouse3Error('LH3_RECEIPT_MISMATCH')
  await chrome.storage.local.remove(key)
  return true
}

/** Adapter retains the existing capture and HMAC bytes; no synthetic action is created. */
export async function lighthouse3Operation(
  endpoint: string,
  operation: string,
  variables: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (['CreateExtensionPairing', 'PollExtensionPairing'].includes(operation))
    return lighthouse3Pairing(endpoint, operation, variables, signal)
  if (operation === 'Me') return { me: (await received(endpoint, signal)).me }
  if (
    [
      'AvailableEngagements',
      'ManualAvailableEngagements',
      'AvailableTweets',
      'ManualAvailableTweets',
    ].includes(operation)
  ) {
    // The v3 acceptance profile only syncs already claimed tasks. Authenticate even an empty source.
    await received(endpoint, signal)
    return operation.includes('Tweets')
      ? { availableTweets: [] }
      : { availableEngagements: [] }
  }
  if (
    ['MyReservedEngagements', 'ManualMyReservedEngagements'].includes(operation)
  ) {
    const snapshot = await received(endpoint, signal)
    return {
      myReservedEngagements: snapshot.tasks.map((task) => ({
        ...task,
        expectedReward:
          Number(task.acceptedRewardLux) / Number(task.penaltyDivisor),
        myExpectedReward:
          Number(task.acceptedRewardLux) / Number(task.penaltyDivisor),
        actions: [
          {
            actionType: 'LIKE',
            baseReward:
              Number(task.acceptedRewardLux) / Number(task.penaltyDivisor),
            targetCount: 1,
          },
        ],
      })),
    }
  }
  const args = variables as {
    campaignId?: string
    input?: {
      campaignId?: string
      nonce?: string
      ticket?: string
      [key: string]: unknown
    }
  }
  if (operation === 'MintEngagementTicket') {
    const snapshot = await received(endpoint, signal)
    const task = snapshot.tasks.find((t) => t.id === args.campaignId)
    if (!task) throw new Lighthouse3Error('NO_ACTIVE_RESERVATION')
    const ticket = (await likeRequest(
      endpoint,
      task.acceptedReceiptId,
      'ticket',
      {},
      signal,
    )) as { ticket: string; macKey: string; expiresAt: string }
    const token = await localStore.get('apiToken')
    const key = `lh3-ticket:${await sha256Hex(token ?? '')}:${await sha256Hex(ticket.ticket)}`
    await chrome.storage.local.set({
      [key]: {
        receiptId: task.acceptedReceiptId,
        campaignId: task.id,
        expiresAt: ticket.expiresAt,
        requestKey: crypto.randomUUID(),
      },
    })
    return { mintEngagementTicket: ticket }
  }
  if (operation === 'SubmitEngagementProof') {
    const proof = args.input
    if (!proof?.campaignId || typeof proof.ticket !== 'string')
      throw new Lighthouse3Error('LH3_PROOF_INVALID')
    const token = await localStore.get('apiToken')
    const key = `lh3-ticket:${await sha256Hex(token ?? '')}:${await sha256Hex(proof.ticket)}`
    const journal = (await chrome.storage.local.get(key))[key] as
      | { receiptId: string; campaignId: string; requestKey: string }
      | undefined
    if (!journal || journal.campaignId !== proof.campaignId)
      throw new Lighthouse3Error('LH3_RECEIPT_INVALID')
    const device = await getOrCreateDeviceIdentity()
    const pending = await pendingKey(proof.campaignId)
    // Keep the first command intact until its outcome is known.
    if (!(await chrome.storage.local.get(pending))[pending]) {
      await chrome.storage.local.set({
        [pending]: {
          receiptId: journal.receiptId,
          input: {
            requestKey: journal.requestKey,
            deviceId: device.deviceId,
            proof,
          },
        },
      })
    }
    await resumeLighthouse3Proof(endpoint, proof.campaignId, signal)
    return { submitEngagementProof: { accepted: true, status: 'VERIFYING' } }
  }
  throw new Lighthouse3Error('LH3_OPERATION_NOT_CONNECTED')
}
