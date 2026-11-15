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

const engagementActions = [
  'LIKE',
  'RT',
  'COMMENT',
  'FOLLOW',
  'COMMENT_LIKE',
] as const
type V3Action = {
  actionType: (typeof engagementActions)[number]
  baseReward: number
  targetCount: number
}
type V3Task = {
  id: string
  acceptedReceiptId: string
  acceptedRewardLux: string
  penaltyDivisor: string
  actions?: V3Action[]
  [key: string]: unknown
}
type V3Snapshot = {
  scope: 'OWN_RESERVED_LIKE' | 'OWN_RESERVED_ENGAGEMENT'
  me: unknown
  tasks: V3Task[]
}
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
  if (
    !['OWN_RESERVED_LIKE', 'OWN_RESERVED_ENGAGEMENT'].includes(result?.scope) ||
    !Array.isArray(result.tasks)
  )
    throw new Lighthouse3Error('LH3_RESPONSE_INVALID')
  if (result.scope === 'OWN_RESERVED_ENGAGEMENT') {
    for (const task of result.tasks) {
      if (
        !Array.isArray(task.actions) ||
        task.actions.length === 0 ||
        task.actions.some(
          (a) =>
            !a ||
            !engagementActions.includes(a.actionType) ||
            !Number.isFinite(a.baseReward) ||
            a.baseReward < 0 ||
            !Number.isInteger(a.targetCount) ||
            a.targetCount < 1,
        ) ||
        new Set(task.actions.map((a) => a.actionType)).size !==
          task.actions.length
      )
        throw new Lighthouse3Error('LH3_RESPONSE_INVALID')
    }
  }
  return result
}
async function engagementRequest(
  endpoint: string,
  receiptId: string,
  kind: 'context' | 'ticket' | 'submit',
  input: unknown,
  signal?: AbortSignal,
  family: 'like' | 'engagement' = 'like',
) {
  if (!/^[A-Za-z0-9_-]+$/.test(receiptId))
    throw new Lighthouse3Error('LH3_RECEIPT_INVALID')
  const suffix = kind === 'submit' ? 'verification' : kind
  return lighthouse3Post(
    endpoint,
    `dispatch/acceptances/${receiptId}/${family}-${suffix}`,
    input,
    {
      signal,
      operation: {
        id: `lh3.${family}.${kind}.v1`,
        name:
          family === 'engagement'
            ? kind === 'ticket'
              ? 'MintEngagementTicket'
              : 'SubmitEngagementVerification'
            : kind === 'context'
              ? 'ReadOwnPluginLikeTask'
              : kind === 'ticket'
                ? 'MintLikeEngagementTicket'
                : 'SubmitLikeVerification',
        document: `POST /api/v3/dispatch/acceptances/:acceptedReceiptId/${family}-${suffix}`,
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

const campaignOperations = new Map<string, Promise<unknown>>()

async function serializeCampaign<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = campaignOperations.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(work)
  campaignOperations.set(key, current)
  try {
    return await current
  } finally {
    if (campaignOperations.get(key) === current) campaignOperations.delete(key)
  }
}

// Only immutable input validation failures known to precede admission. Never
// clear on expiry, replay, auth, signature or infrastructure failures: an earlier
// attempt of the same command may already have been admitted.
const preAdmissionRefusals = new Set([
  'ENGAGEMENT_PROOF_INVALID',
  'PROOF_COMMENT_INVALID',
  'COMMENT_TOO_SHORT',
])

// Generic submit checks the durable requestKey result before active/prepare/evaluate.
// These 409s therefore confirm that this command was not admitted (unlike LIKE).
const genericPreAdmissionConflicts = new Set([
  'ENGAGEMENT_CAPTURE_REQUIRED',
  'PROOF_TS_SKEW',
  'ENGAGEMENT_TICKET_EXPIRED',
])

/** Reuse the exact command after an uncertain response, including its original proof. */
export async function resumeLighthouse3Proof(
  endpoint: string,
  campaignId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const key = await pendingKey(campaignId)
  return serializeCampaign(key, () =>
    resumePendingProof(endpoint, campaignId, key, signal),
  )
}

async function resumePendingProof(
  endpoint: string,
  campaignId: string,
  key: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const pending = (await chrome.storage.local.get(key))[key] as
    | {
        receiptId: string
        family?: 'like' | 'engagement'
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
  const result = (await engagementRequest(
    endpoint,
    pending.receiptId,
    'submit',
    pending.input,
    signal,
    pending.family ?? 'like',
  ).catch(async (error: unknown) => {
    if (
      error instanceof Lighthouse3Error &&
      (((error.httpStatus === 400 || error.httpStatus === 422) &&
        preAdmissionRefusals.has(error.code)) ||
        (pending.family === 'engagement' &&
          error.httpStatus === 409 &&
          genericPreAdmissionConflicts.has(error.code)))
    )
      await chrome.storage.local.remove(key)
    throw error
  })) as {
    status: string
    requestKey: string
    campaignId: string
    acceptedReceiptId?: string
  }
  if (
    result?.status !== 'VERIFYING' ||
    result.requestKey !== pending.input.requestKey ||
    result.campaignId !== campaignId ||
    (pending.family === 'engagement' &&
      result.acceptedReceiptId !== pending.receiptId)
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
        targetUsername:
          typeof task.targetUsername === 'string'
            ? task.targetUsername.trim().replace(/^@/, '').toLowerCase()
            : task.targetUsername,
        expectedReward:
          Number(task.acceptedRewardLux) / Number(task.penaltyDivisor),
        myExpectedReward:
          Number(task.acceptedRewardLux) / Number(task.penaltyDivisor),
        actions:
          snapshot.scope === 'OWN_RESERVED_ENGAGEMENT'
            ? task.actions
            : [
                {
                  actionType: 'LIKE',
                  baseReward:
                    Number(task.acceptedRewardLux) /
                    Number(task.penaltyDivisor),
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
    const family =
      snapshot.scope === 'OWN_RESERVED_LIKE' ||
      (task.actions?.length === 1 && task.actions[0].actionType === 'LIKE')
        ? 'like'
        : 'engagement'
    const ticket = (await engagementRequest(
      endpoint,
      task.acceptedReceiptId,
      'ticket',
      {},
      signal,
      family,
    )) as { ticket: string; macKey: string; expiresAt: string }
    const token = await localStore.get('apiToken')
    const key = `lh3-ticket:${await sha256Hex(token ?? '')}:${await sha256Hex(ticket.ticket)}`
    await chrome.storage.local.set({
      [key]: {
        receiptId: task.acceptedReceiptId,
        family,
        campaignId: task.id,
        expiresAt: ticket.expiresAt,
        requestKey: crypto.randomUUID(),
        targetTweetId: typeof task.tweetId === 'string' ? task.tweetId : null,
        requiredActions:
          snapshot.scope === 'OWN_RESERVED_LIKE'
            ? ['LIKE']
            : task.actions!.map((action) => action.actionType),
        targetUsername:
          typeof task.targetUsername === 'string'
            ? task.targetUsername.trim().replace(/^@/, '').toLowerCase()
            : null,
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
      | {
          receiptId: string
          campaignId: string
          requestKey: string
          family?: 'like' | 'engagement'
          requiredActions?: string[]
          targetUsername?: string | null
          targetTweetId?: string | null
        }
      | undefined
    if (!journal || journal.campaignId !== proof.campaignId)
      throw new Lighthouse3Error('LH3_RECEIPT_INVALID')
    const device = await getOrCreateDeviceIdentity()
    const pending = await pendingKey(proof.campaignId)
    return serializeCampaign(pending, async () => {
      // Keep the first command intact until its outcome is known.
      if (!(await chrome.storage.local.get(pending))[pending]) {
        // Check new commands only; an uncertain command must replay unchanged.
        // Older journals have no requirements and retain their original behavior.
        if (journal.requiredActions) {
          const actions = Array.isArray(proof.actions) ? proof.actions : []
          const has = (type: string): boolean =>
            actions.some(
              (action) =>
                action &&
                action.actionType === type &&
                (type === 'FOLLOW'
                  ? typeof action.handle === 'string' &&
                    !!journal.targetUsername &&
                    action.handle.trim().replace(/^@/, '').toLowerCase() ===
                      journal.targetUsername
                  : typeof action.tweetId === 'string' &&
                    action.tweetId.length > 0 &&
                    (journal.targetTweetId === undefined ||
                      action.tweetId === journal.targetTweetId)),
            )
          if (
            (journal.targetTweetId !== undefined &&
              actions.some(
                (action) =>
                  !action ||
                  (action.actionType !== 'FOLLOW' &&
                    action.tweetId !== journal.targetTweetId),
              )) ||
            !journal.requiredActions.every((type) =>
              type === 'COMMENT_LIKE'
                ? has('COMMENT') && has('LIKE')
                : has(type),
            )
          )
            throw new Lighthouse3Error('LH3_ACTIONS_INCOMPLETE')
        }

        await chrome.storage.local.set({
          [pending]: {
            receiptId: journal.receiptId,
            family: journal.family ?? 'like',
            input: {
              requestKey: journal.requestKey,
              deviceId: device.deviceId,
              proof,
            },
          },
        })
      }
      await resumePendingProof(endpoint, proof.campaignId!, pending, signal)
      return { submitEngagementProof: { accepted: true, status: 'VERIFYING' } }
    })
  }
  throw new Lighthouse3Error('LH3_OPERATION_NOT_CONNECTED')
}
