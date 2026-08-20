import { WEB_ENDPOINT } from '@/lib/env'
import {
  type CapturedRequest,
  CaptureSession,
  clearCapturedRequest,
  createCaptureBinding,
  type RequestBodyDetails,
  type RequestDetails,
} from './capture'
import {
  assertConnectorAvailable,
  type CapturedConnector,
  type Connector,
  extractIdentity,
  type V1Connector,
} from './interpreter'
import { assertVerifierProfile, ZKTLS_PROFILE } from './profile'
import {
  type ProviderAction,
  runProviderActionsInPage,
} from './provider-actions'
import { parseZkTlsRuntimeRequest } from './runtime-request'
import {
  assertTicketAvailable,
  type ConfigEnvelope,
  fetchAndVerifySignedConfig,
  type Ticket,
  type TicketEnvelope,
} from './signed-config'

type V1Job = {
  kind: 'v1'
  sessionId: string
  connectorId: string
  config: V1Connector
  ticket: Ticket
  origin: string
  tabId: number
  cookie?: string
  done?: (cookie: string | null) => void
}
type CaptureJob = {
  kind: 'capture'
  sessionId: string
  connectorId: string
  config: CapturedConnector
  ticket: Ticket
  origin: string
  tabId: number
  capture: CaptureSession
  done?: (captured: CapturedRequest | null) => void
}
type Job = V1Job | CaptureJob
type Permission = {
  requestId: string
  origin: string
  connectorId: string
  resolve: (ok: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export type ZkTlsRunRequest = {
  sessionId: string
  connectorId: string
  correlationId: string
}

export type ZkTlsRunResult = {
  type: 'zktls-prove-result'
  correlationId: string
  status: 'submitted' | 'pending_login' | 'error' | 'unsupported'
  code?: string
}

let job: Job | null = null
let permission: Permission | null = null

class ZkTlsPermissionDeniedError extends Error {}

function exactOriginPattern(origin: string): string {
  return `${new URL(origin).origin}/*`
}
function clearJob(): void {
  if (job?.kind === 'v1') job.cookie = undefined
  if (job?.kind === 'capture') job.capture.clear()
  job = null
}
function permissionUrl(): string {
  return chrome.runtime.getURL('zktls-permission.html')
}

function assertAvailable(config: Connector, ticket: Ticket): void {
  const now = new Date().toISOString()
  assertConnectorAvailable(config, now)
  assertTicketAvailable(ticket, now)
  assertVerifierProfile(config)
}

async function signedConnector(
  sessionId: string,
  connectorId: string,
): Promise<{
  config: Connector
  ticket: Ticket
  configEnvelope: ConfigEnvelope
  ticketEnvelope: TicketEnvelope
}> {
  if (!ZKTLS_PROFILE.enabled || !ZKTLS_PROFILE.apiEndpoint)
    throw new Error('zktls disabled')
  const endpoint = new URL(ZKTLS_PROFILE.apiEndpoint)
  endpoint.searchParams.set('session_id', sessionId)
  endpoint.searchParams.set('connector_id', connectorId)
  const result = await fetchAndVerifySignedConfig(endpoint.href, {
    publicKeys: ZKTLS_PROFILE.publicKeys,
    now: new Date().toISOString(),
    local: ZKTLS_PROFILE.local,
  })
  if (
    result.ticket.session_id !== sessionId ||
    result.ticket.connector_id !== connectorId ||
    result.config.connector_id !== connectorId
  )
    throw new Error('ticket mismatch')
  assertAvailable(result.config, result.ticket)
  return result
}

async function ensurePermission(
  origin: string,
  connectorId: string,
): Promise<void> {
  const permissions = { origins: [exactOriginPattern(origin)] }
  if (await chrome.permissions.contains(permissions)) return
  if (permission) throw new Error('permission pending')
  await new Promise<void>((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const pending: Permission = {
      requestId,
      origin,
      connectorId,
      resolve: (ok) => {
        clearTimeout(pending.timer)
        permission = null
        ok ? resolve() : reject(new ZkTlsPermissionDeniedError())
      },
      timer: setTimeout(() => pending.resolve(false), 30_000),
    }
    permission = pending
    void chrome.tabs
      .create({
        url: `${permissionUrl()}?request_id=${encodeURIComponent(requestId)}`,
      })
      .catch(() => pending.resolve(false))
  })
}

async function connectorTab(origin: string): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  })
  if (active?.url && new URL(active.url).origin === origin) return active
  const tabs = await chrome.tabs.query({ url: exactOriginPattern(origin) })
  return tabs.find((tab) => tab.id !== undefined) ?? null
}

async function collectIdentity(
  tabId: number,
  config: V1Connector,
): Promise<string | null> {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () =>
      Array.from(document.querySelectorAll('meta')).map((meta) => ({
        name: meta.name,
        content: meta.content,
      })),
  })
  try {
    return extractIdentity(config, result[0]?.result ?? [])
  } catch {
    return null
  }
}

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('zktls-offscreen.html')
  const contexts = await (
    chrome.runtime.getContexts as unknown as (
      filter: unknown,
    ) => Promise<{ documentUrl?: string }[]>
  )({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
  if (!contexts.some((context) => context.documentUrl === url))
    await (
      chrome.offscreen.createDocument as unknown as (
        request: unknown,
      ) => Promise<void>
    )({
      url: 'zktls-offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run the packaged TLSNotary prover worker.',
    })
}

function waitForCookie(active: Job): Promise<string | null> {
  if (active.kind !== 'v1') throw new Error('invalid v1 capture job')
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      active.done = undefined
      resolve(null)
    }, 10_000)
    active.done = (cookie) => {
      clearTimeout(timer)
      active.done = undefined
      resolve(cookie)
    }
  })
}

function waitForCapture(active: CaptureJob): Promise<CapturedRequest | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      active.done = undefined
      resolve(null)
    }, 60_000)
    active.done = (captured) => {
      clearTimeout(timer)
      active.done = undefined
      resolve(captured)
    }
  })
}

export function activateCaptureTab(tabId: number): Promise<chrome.tabs.Tab> {
  return chrome.tabs.update(tabId, { active: true })
}

export async function runProviderActions(
  tabId: number,
  origin: string,
  actions: ProviderAction[] | undefined,
): Promise<void> {
  if (!actions?.length) return
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: runProviderActionsInPage,
    args: [origin, actions],
  })
}

async function proveCapturedRequest(
  request: ZkTlsRunRequest,
  config: CapturedConnector,
  ticket: Ticket,
  configEnvelope: ConfigEnvelope,
  ticketEnvelope: TicketEnvelope,
): Promise<ZkTlsRunResult> {
  await ensurePermission(config.origin, request.connectorId)
  assertAvailable(config, ticket)
  const tab = await connectorTab(config.origin)
  if (!tab?.id) {
    await chrome.tabs.create({ url: config.origin })
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'pending_login',
    }
  }
  clearJob()
  const active: CaptureJob = {
    kind: 'capture',
    sessionId: request.sessionId,
    connectorId: request.connectorId,
    config,
    ticket,
    origin: config.origin,
    tabId: tab.id,
    capture: new CaptureSession(
      createCaptureBinding({
        tabId: tab.id,
        frameId: 0,
        sessionId: request.sessionId,
        providerId: config.connector_id,
        revision: config.revision,
        origin: config.origin,
        method: config.request.method,
        ...(config.interpreter_version === 2
          ? { path: config.request.path }
          : {
              matcher: config.request.matcher,
              ...(config.request.method === 'POST'
                ? { bodyMatcher: config.request.body }
                : {}),
            }),
        secretHeaders: config.request.secret_headers,
      }),
    ),
  }
  job = active
  const captured = waitForCapture(active)
  let value: CapturedRequest | null
  try {
    await activateCaptureTab(tab.id)
    await runProviderActions(
      tab.id,
      config.origin,
      config.interpreter_version === 3 ? config.actions : undefined,
    )
    value = await captured
  } catch {
    active.done?.(null)
    clearJob()
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    }
  }
  clearJob()
  if (!value)
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    }
  try {
    await ensureOffscreen()
    const result = (await chrome.runtime.sendMessage({
      type: 'zktls-offscreen-prove',
      sessionId: request.sessionId,
      connectorId: request.connectorId,
      config,
      ticket,
      configEnvelope,
      ticketEnvelope,
      captured: value,
    })) as {
      status: 'submitted' | 'error'
      code?: string
    }
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: result.status,
      ...(result.code ? { code: result.code } : {}),
    }
  } finally {
    clearCapturedRequest(value)
  }
}

async function runValidatedZkTlsRequest(
  request: ZkTlsRunRequest,
): Promise<ZkTlsRunResult> {
  if (!ZKTLS_PROFILE.enabled || /firefox/i.test(navigator.userAgent))
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'unsupported',
    }
  try {
    const { config, ticket, configEnvelope, ticketEnvelope } =
      await signedConnector(request.sessionId, request.connectorId)
    if (config.interpreter_version === 2 || config.interpreter_version === 3)
      return await proveCapturedRequest(
        request,
        config,
        ticket,
        configEnvelope,
        ticketEnvelope,
      )
    if (config.response_format !== 'html')
      return {
        type: 'zktls-prove-result',
        correlationId: request.correlationId,
        status: 'error',
        code: 'UNSUPPORTED_CONNECTOR',
      }
    await ensurePermission(config.origin, request.connectorId)
    assertAvailable(config, ticket)
    const tab = await connectorTab(config.origin)
    if (!tab?.id) {
      await chrome.tabs.create({ url: config.origin })
      return {
        type: 'zktls-prove-result',
        correlationId: request.correlationId,
        status: 'pending_login',
      }
    }
    const identity = await collectIdentity(tab.id, config)
    if (!identity) {
      await chrome.tabs.update(tab.id, { active: true })
      return {
        type: 'zktls-prove-result',
        correlationId: request.correlationId,
        status: 'pending_login',
      }
    }
    assertAvailable(config, ticket)
    clearJob()
    const active: V1Job = {
      kind: 'v1',
      sessionId: request.sessionId,
      connectorId: request.connectorId,
      config,
      ticket,
      origin: config.origin,
      tabId: tab.id,
    }
    job = active
    const cookie = waitForCookie(active)
    await chrome.tabs.reload(tab.id)
    const value = await cookie
    clearJob()
    if (!value) {
      await chrome.tabs.update(tab.id, { active: true })
      return {
        type: 'zktls-prove-result',
        correlationId: request.correlationId,
        status: 'pending_login',
      }
    }
    await ensureOffscreen()
    const result = (await chrome.runtime.sendMessage({
      type: 'zktls-offscreen-prove',
      sessionId: request.sessionId,
      connectorId: request.connectorId,
      config,
      ticket,
      configEnvelope,
      ticketEnvelope,
      identity,
      cookie: value,
    })) as { status: 'submitted' | 'error'; code?: string }
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: result.status,
      ...(result.code ? { code: result.code } : {}),
    }
  } catch (error) {
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'error',
      code:
        error instanceof ZkTlsPermissionDeniedError
          ? 'PERMISSION_DENIED'
          : 'ZKTLS_SETUP_FAILED',
    }
  }
}

export async function proveZkTlsSession(
  request: ZkTlsRunRequest,
): Promise<ZkTlsRunResult> {
  return runValidatedZkTlsRequest(request)
}

export async function handleZkTlsProof(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<ZkTlsRunResult | null> {
  const request = parseZkTlsRuntimeRequest(
    message,
    sender,
    new URL(WEB_ENDPOINT).origin,
  )
  return request ? proveZkTlsSession(request) : null
}

export function registerZkTlsRuntime(): void {
  if (/firefox/i.test(navigator.userAgent)) return
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const active = job
      if (active?.kind !== 'capture') return
      try {
        active.capture.observeBody(details as RequestBodyDetails)
      } catch {
        active.done?.(null)
      }
    },
    { urls: ['https://*/*'] },
    ['requestBody'],
  )
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const active = job
      if (!active || details.tabId !== active.tabId) return
      if (active.kind === 'v1') {
        if (
          details.method !== active.config.request.method ||
          new URL(details.url).origin !== active.origin
        )
          return
        const cookie = details.requestHeaders?.find(
          (header) => header.name.toLowerCase() === 'cookie',
        )?.value
        if (cookie) {
          active.cookie = cookie
          active.done?.(cookie)
        }
        return
      }
      try {
        active.capture.observe(details as RequestDetails)
      } catch {
        active.done?.(null)
      }
    },
    { urls: ['https://*/*'] },
    ['requestHeaders', 'extraHeaders'],
  )
  chrome.webRequest.onBeforeRedirect.addListener(
    (details) => {
      const active = job
      if (active?.kind !== 'capture') return
      if (
        active.capture.reject(details.requestId, 'captured request redirected')
      )
        active.done?.(null)
    },
    { urls: ['https://*/*'] },
  )
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const active = job
      if (active?.kind !== 'capture') return
      if (active.capture.reject(details.requestId, 'captured request failed'))
        active.done?.(null)
    },
    { urls: ['https://*/*'] },
  )
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const active = job
      if (
        active?.kind !== 'capture' ||
        !active.capture.completes(details.requestId)
      )
        return
      try {
        active.done?.(active.capture.take())
      } catch {
        active.done?.(null)
      }
    },
    { urls: ['https://*/*'] },
  )

  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!message || typeof message !== 'object') return
    const raw = message as {
      type?: unknown
      requestId?: unknown
      granted?: unknown
    }
    if (raw.type === 'zktls-permission-preview') {
      const pending = permission
      if (
        !pending ||
        sender.id !== chrome.runtime.id ||
        new URL(sender.url ?? 'chrome://invalid').pathname !==
          new URL(permissionUrl()).pathname ||
        raw.requestId !== pending.requestId
      )
        return null
      return { origin: pending.origin, connectorId: pending.connectorId }
    }
    if (raw.type === 'zktls-permission-result') {
      const pending = permission
      if (
        !pending ||
        sender.id !== chrome.runtime.id ||
        new URL(sender.url ?? 'chrome://invalid').pathname !==
          new URL(permissionUrl()).pathname ||
        raw.requestId !== pending.requestId ||
        typeof raw.granted !== 'boolean'
      )
        return null
      const granted = raw.granted
      return chrome.permissions
        .contains({ origins: [exactOriginPattern(pending.origin)] })
        .then((contained) => {
          pending.resolve(granted && contained)
          return null
        })
    }
  })
}
