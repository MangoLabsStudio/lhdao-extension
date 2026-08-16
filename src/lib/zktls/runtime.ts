import { WEB_ENDPOINT } from '@/lib/env'
import {
  type CapturedRequest,
  CaptureSession,
  clearCapturedRequest,
  createCaptureBinding,
  type RequestDetails,
} from './capture'
import {
  assertConnectorAvailable,
  type Connector,
  extractIdentity,
  type V1Connector,
  type V2Connector,
} from './interpreter'
import { assertVerifierProfile, ZKTLS_PROFILE } from './profile'
import { parseZkTlsRuntimeRequest } from './runtime-request'
import {
  assertTicketAvailable,
  fetchAndVerifySignedConfig,
  type Ticket,
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
type V2Job = {
  kind: 'v2'
  sessionId: string
  connectorId: string
  config: V2Connector
  ticket: Ticket
  origin: string
  tabId: number
  capture: CaptureSession
  done?: (captured: CapturedRequest | null) => void
}
type Job = V1Job | V2Job
type Permission = {
  requestId: string
  origin: string
  connectorId: string
  resolve: (ok: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

let job: Job | null = null
let permission: Permission | null = null

function exactOriginPattern(origin: string): string {
  return `${new URL(origin).origin}/*`
}
function clearJob(): void {
  if (job?.kind === 'v1') job.cookie = undefined
  if (job?.kind === 'v2') job.capture.clear()
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
): Promise<{ config: Connector; ticket: Ticket }> {
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
        ok ? resolve() : reject(new Error('permission denied'))
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

function waitForCapture(active: V2Job): Promise<CapturedRequest | null> {
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

async function proveCapturedRequest(
  request: ReturnType<typeof parseZkTlsRuntimeRequest>,
  config: V2Connector,
  ticket: Ticket,
): Promise<unknown> {
  if (!request) return null
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
  const active: V2Job = {
    kind: 'v2',
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
        path: config.request.path,
        secretHeaders: config.request.secret_headers,
      }),
    ),
  }
  job = active
  const captured = waitForCapture(active)
  await activateCaptureTab(tab.id)
  const value = await captured
  clearJob()
  if (!value)
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    }
  await ensureOffscreen()
  let pending: Promise<unknown>
  try {
    pending = chrome.runtime.sendMessage({
      type: 'zktls-offscreen-prove',
      sessionId: request.sessionId,
      connectorId: request.connectorId,
      config,
      ticket,
      captured: value,
    })
  } finally {
    clearCapturedRequest(value)
  }
  const result = (await pending) as {
    status: 'submitted' | 'error'
    code?: string
  }
  return {
    type: 'zktls-prove-result',
    correlationId: request.correlationId,
    status: result.status,
    ...(result.code ? { code: result.code } : {}),
  }
}

export async function handleZkTlsProof(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const request = parseZkTlsRuntimeRequest(
    message,
    sender,
    new URL(WEB_ENDPOINT).origin,
  )
  if (!request) return null
  if (!ZKTLS_PROFILE.enabled || /firefox/i.test(navigator.userAgent))
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'unsupported',
    }
  try {
    const { config, ticket } = await signedConnector(
      request.sessionId,
      request.connectorId,
    )
    if (config.interpreter_version === 2)
      return await proveCapturedRequest(request, config, ticket)
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
      identity,
      cookie: value,
    })) as { status: 'submitted' | 'error'; code?: string }
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: result.status,
      ...(result.code ? { code: result.code } : {}),
    }
  } catch {
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'error',
      code: 'ZKTLS_SETUP_FAILED',
    }
  }
}

export function registerZkTlsRuntime(): void {
  if (/firefox/i.test(navigator.userAgent)) return
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
      if (active?.kind !== 'v2') return
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
      if (active?.kind !== 'v2') return
      if (active.capture.reject(details.requestId, 'captured request failed'))
        active.done?.(null)
    },
    { urls: ['https://*/*'] },
  )
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const active = job
      if (active?.kind !== 'v2' || !active.capture.completes(details.requestId))
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
