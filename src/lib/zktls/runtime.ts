import { WEB_ENDPOINT } from '@/lib/env'
import type { ProductZkTlsDiagnosticEvent } from '@/types/product-experience'
import {
  type CapturedRequest,
  CaptureSession,
  clearCapturedRequest,
  createCaptureBinding,
  type RedirectDetails,
  type RequestBodyDetails,
  type RequestDetails,
} from './capture'
import { sanitizeZkTlsDebugValue } from './debug'
import {
  assertConnectorAvailable,
  type CapturedConnector,
  type Connector,
  extractIdentity,
  publicDnsHost,
  type V1Connector,
  type V4Connector,
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

type PermissionRemovalListener = (
  permissions: chrome.permissions.Permissions,
) => void
type PermissionRemovedEvent = {
  addListener(listener: PermissionRemovalListener): void
  removeListener(listener: PermissionRemovalListener): void
}
type JobAuthorization = {
  permissionDenied?: boolean
  permissionRemovalListener?: PermissionRemovalListener
}
type V1Job = JobAuthorization & {
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
type RuntimeCapturedConnector = CapturedConnector | V4Connector
type CaptureJob = JobAuthorization & {
  kind: 'capture'
  sessionId: string
  connectorId: string
  config: RuntimeCapturedConnector
  ticket: Ticket
  origin: string
  tabId: number
  capture: CaptureSession
  done?: (captured: CapturedRequest | null) => void
}
type Job = V1Job | CaptureJob
type Permission = {
  requestId: string
  origins: readonly [string] | readonly [string, string]
  connectorId: string
  settled: boolean
  resolve: (ok: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export type ZkTlsRunRequest = {
  sessionId: string
  connectorId: string
  correlationId: string
  expiresAt?: string
  onDiagnostic?: (event: ProductZkTlsDiagnosticEvent) => void | Promise<void>
}

export type ZkTlsRunResult = {
  type: 'zktls-prove-result'
  correlationId: string
  status: 'submitted' | 'pending_login' | 'error' | 'unsupported'
  code?: string
}

let job: Job | null = null
let permission: Permission | null = null
let proofFlight: Promise<ZkTlsRunResult> | null = null
let productWaiter = false

async function reportDiagnostic(
  request: ZkTlsRunRequest,
  event: Omit<ProductZkTlsDiagnosticEvent, 'at'>,
): Promise<void> {
  try {
    await request.onDiagnostic?.({ ...event, at: Date.now() })
  } catch {
    // Diagnostics never affect proof execution.
  }
}

class ZkTlsPermissionDeniedError extends Error {}

function permissionRemovedEvent(): PermissionRemovedEvent {
  return chrome.permissions.onRemoved as unknown as PermissionRemovedEvent
}

function permissionOrigins(
  values: readonly string[],
): readonly [string] | readonly [string, string] {
  const origins = [...new Set(values)].sort()
  if (origins.length < 1 || origins.length > 2)
    throw new Error('permission requires one or two exact HTTPS origins')
  for (const origin of origins) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new Error('permission requires one or two exact HTTPS origins')
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.origin !== origin ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.hostname.includes('*') ||
      !publicDnsHost(url.hostname)
    )
      throw new Error('permission requires one or two exact HTTPS origins')
  }
  return origins.length === 1 ? [origins[0]] : [origins[0], origins[1]]
}

function permissionPatterns(origins: readonly string[]): string[] {
  return origins.map((origin) => `${origin}/*`)
}

function exactOriginPattern(origin: string): string {
  return permissionPatterns(permissionOrigins([origin]))[0]
}
function clearJob(): void {
  const active = job
  job = null
  if (active?.permissionRemovalListener)
    permissionRemovedEvent().removeListener(active.permissionRemovalListener)
  if (active?.kind === 'v1') active.cookie = undefined
  if (active?.kind === 'capture') active.capture.clear()
}

function armJob(active: Job, origins: readonly string[]): void {
  const required = permissionPatterns(permissionOrigins(origins))
  const listener = (removed: chrome.permissions.Permissions) => {
    if (job !== active || !removed.origins?.length) return
    void (async () => {
      let allowed = false
      try {
        allowed = await chrome.permissions.contains({ origins: required })
      } catch {}
      if (allowed || job !== active) return
      active.permissionDenied = true
      active.done?.(null)
      clearJob()
    })()
  }
  permissionRemovedEvent().addListener(listener)
  active.permissionRemovalListener = listener
  job = active
}
function permissionUrl(): string {
  return chrome.runtime.getURL('zktls-permission.html')
}

function isPermissionSender(
  sender: chrome.runtime.MessageSender,
  pendingRequestId: string,
  messageRequestId: unknown,
): boolean {
  if (
    sender.id !== chrome.runtime.id ||
    typeof messageRequestId !== 'string' ||
    !messageRequestId ||
    messageRequestId !== pendingRequestId
  )
    return false
  try {
    const expected = new URL(permissionUrl())
    const actual = new URL(sender.url ?? '')
    return (
      (expected.protocol === 'chrome-extension:' ||
        expected.protocol === 'moz-extension:') &&
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      !actual.username &&
      !actual.password &&
      !actual.hash &&
      actual.search === `?request_id=${encodeURIComponent(pendingRequestId)}` &&
      actual.href ===
        `${expected.href}?request_id=${encodeURIComponent(pendingRequestId)}`
    )
  } catch {
    return false
  }
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
    now: () => new Date().toISOString(),
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

export async function ensurePermissions(
  origins: readonly string[],
  connectorId: string,
): Promise<void> {
  const normalized = permissionOrigins(origins)
  const permissions = { origins: permissionPatterns(normalized) }
  if (await chrome.permissions.contains(permissions)) return
  if (permission) throw new Error('permission pending')
  await new Promise<void>((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const pending: Permission = {
      requestId,
      origins: normalized,
      connectorId,
      settled: false,
      resolve: (ok) => {
        if (pending.settled) return
        pending.settled = true
        clearTimeout(pending.timer)
        if (permission === pending) permission = null
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

function tabAtOrigin(
  tab: chrome.tabs.Tab | undefined,
  origin: string,
): tab is chrome.tabs.Tab {
  if (!tab?.url) return false
  try {
    return new URL(tab.url).origin === origin
  } catch {
    return false
  }
}

export async function connectorTab(
  origin: string,
): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  })
  if (tabAtOrigin(active, origin)) return active
  const tabs = await chrome.tabs.query({ url: exactOriginPattern(origin) })
  return (
    tabs.find((tab) => tab.id !== undefined && tabAtOrigin(tab, origin)) ?? null
  )
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
  config: RuntimeCapturedConnector,
  ticket: Ticket,
  configEnvelope: ConfigEnvelope,
  ticketEnvelope: TicketEnvelope,
): Promise<ZkTlsRunResult> {
  const pageOrigin =
    config.interpreter_version === 4 ? config.page_origin : config.origin
  await reportDiagnostic(request, {
    stage: 'capture-started',
    status: 'running',
    details: {
      pageOrigin,
      targetOrigin: config.origin,
      method: config.request.method,
    },
  })
  await ensurePermissions([pageOrigin, config.origin], request.connectorId)
  assertAvailable(config, ticket)
  const tab = await connectorTab(pageOrigin)
  if (!tab?.id) {
    await chrome.tabs.create({ url: pageOrigin })
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
      config.interpreter_version === 4
        ? createCaptureBinding({
            interpreterVersion: 4,
            maxSentData: config.request.max_sent_data,
            tabId: tab.id,
            frameId: 0,
            sessionId: request.sessionId,
            providerId: config.connector_id,
            revision: config.revision,
            pageOrigin: config.page_origin,
            targetOrigin: config.origin,
            method: config.request.method,
            matcher: config.request.matcher,
            ...(config.request.method === 'POST'
              ? {
                  template: config.request.body,
                  contentType: config.request.content_type,
                }
              : {}),
            publicHeaders: config.request.public_headers,
            variables: config.variables,
            resolvedVariables: config.resolved_variables,
          })
        : createCaptureBinding({
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
  armJob(active, [pageOrigin, config.origin])
  const captured = waitForCapture(active)
  let value: CapturedRequest | null
  try {
    const ready = await activateCaptureTab(tab.id)
    if (
      config.interpreter_version === 4 &&
      !tabAtOrigin(ready, config.page_origin)
    )
      throw new Error('page tab left signed origin')
    await runProviderActions(
      tab.id,
      config.origin,
      config.interpreter_version === 3 ? config.actions : undefined,
    )
    value = await captured
  } catch (error) {
    const permissionDenied = active.permissionDenied
    active.done?.(null)
    clearJob()
    if (permissionDenied) throw new ZkTlsPermissionDeniedError()
    await reportDiagnostic(request, {
      stage: 'capture-failed',
      status: 'failed',
      error: sanitizeZkTlsDebugValue(error),
    })
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    }
  }
  clearJob()
  if (active.permissionDenied) {
    if (value) clearCapturedRequest(value)
    throw new ZkTlsPermissionDeniedError()
  }
  if (!value) {
    await reportDiagnostic(request, {
      stage: 'capture-failed',
      status: 'failed',
      error: { message: 'No matching request was captured' },
    })
    return {
      type: 'zktls-prove-result',
      correlationId: request.correlationId,
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    }
  }
  try {
    await reportDiagnostic(request, {
      stage: 'request-captured',
      status: 'passed',
      details: sanitizeZkTlsDebugValue({
        method: config.request.method,
        targetOrigin: config.origin,
        request: value,
        responseContentEncoding:
          config.interpreter_version === 4
            ? (config.response_content_encoding ?? 'identity')
            : undefined,
      }),
    })
    await ensureOffscreen()
    const result = (await chrome.runtime.sendMessage({
      type: 'zktls-offscreen-prove',
      sessionId: request.sessionId,
      connectorId: request.connectorId,
      correlationId: request.correlationId,
      config,
      ticket,
      configEnvelope,
      ticketEnvelope,
      captured: value,
    })) as {
      status: 'submitted' | 'error'
      code?: string
    }
    await reportDiagnostic(request, {
      stage: 'proof-worker-finished',
      status: result.status === 'submitted' ? 'passed' : 'failed',
      details: result,
    })
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
    if (
      config.interpreter_version === 2 ||
      config.interpreter_version === 3 ||
      config.interpreter_version === 4
    )
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
    await ensurePermissions([config.origin], request.connectorId)
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
    armJob(active, [config.origin])
    const cookie = waitForCookie(active)
    await chrome.tabs.reload(tab.id)
    const value = await cookie
    clearJob()
    if (active.permissionDenied) throw new ZkTlsPermissionDeniedError()
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
      correlationId: request.correlationId,
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
    await reportDiagnostic(request, {
      stage: 'setup-failed',
      status: 'failed',
      error: sanitizeZkTlsDebugValue(error),
    })
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

function unavailableResult(
  request: ZkTlsRunRequest,
  code: 'SESSION_EXPIRED' | 'ZKTLS_BUSY',
): ZkTlsRunResult {
  return {
    type: 'zktls-prove-result',
    correlationId: request.correlationId,
    status: 'error',
    code,
  }
}

function beginProof(request: ZkTlsRunRequest): Promise<ZkTlsRunResult> {
  const flight = runValidatedZkTlsRequest(request)
  proofFlight = flight
  return flight.finally(() => {
    if (proofFlight === flight) proofFlight = null
  })
}

async function waitForProofFlight(
  flight: Promise<ZkTlsRunResult>,
  expiresAt: string | undefined,
): Promise<boolean> {
  const deadline = Date.parse(expiresAt ?? '')
  if (!Number.isFinite(deadline)) {
    await flight
    return true
  }
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    const outcome = await new Promise<'flight' | 'timer'>((resolve) => {
      const timer = setTimeout(
        () => resolve('timer'),
        Math.min(remaining, 60_000),
      )
      void flight.then(
        () => {
          clearTimeout(timer)
          resolve('flight')
        },
        () => {
          clearTimeout(timer)
          resolve('flight')
        },
      )
    })
    if (outcome === 'flight') return true
  }
}

export async function proveZkTlsSession(
  request: ZkTlsRunRequest,
): Promise<ZkTlsRunResult> {
  const active = proofFlight
  if (!active) return beginProof(request)
  if (productWaiter) return unavailableResult(request, 'ZKTLS_BUSY')
  productWaiter = true
  try {
    if (!(await waitForProofFlight(active, request.expiresAt))) {
      return unavailableResult(request, 'SESSION_EXPIRED')
    }
    return await beginProof(request)
  } finally {
    productWaiter = false
  }
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
  if (!request) return null
  if (proofFlight || productWaiter) {
    return unavailableResult(request, 'ZKTLS_BUSY')
  }
  return beginProof(request)
}

export function registerZkTlsRuntime(): void {
  if (/firefox/i.test(navigator.userAgent)) return
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const active = job
    if (
      active?.kind !== 'capture' ||
      active.config.interpreter_version !== 4 ||
      active.tabId !== tabId ||
      (!changeInfo.url && !tab.url) ||
      tabAtOrigin(
        { ...tab, url: changeInfo.url ?? tab.url },
        active.config.page_origin,
      )
    )
      return
    active.done?.(null)
    clearJob()
  })
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
        active.capture.redirect(
          details as RedirectDetails,
          'captured request redirected',
        )
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

  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (!message || typeof message !== 'object') return
      const raw = message as {
        type?: unknown
        requestId?: unknown
        granted?: unknown
      }
      if (raw.type === 'zktls-permission-preview') {
        const pending = permission
        if (
          Object.keys(raw).length !== 2 ||
          !Object.hasOwn(raw, 'type') ||
          !Object.hasOwn(raw, 'requestId') ||
          !pending ||
          !isPermissionSender(sender, pending.requestId, raw.requestId) ||
          raw.requestId !== pending.requestId
        )
          return null
        sendResponse?.({
          origins: pending.origins,
          connectorId: pending.connectorId,
        })
        return true
      }
      if (raw.type === 'zktls-permission-result') {
        const pending = permission
        if (
          Object.keys(raw).length !== 3 ||
          !Object.hasOwn(raw, 'type') ||
          !Object.hasOwn(raw, 'requestId') ||
          !Object.hasOwn(raw, 'granted') ||
          !pending ||
          !isPermissionSender(sender, pending.requestId, raw.requestId) ||
          raw.requestId !== pending.requestId ||
          typeof raw.granted !== 'boolean'
        )
          return null
        const granted = raw.granted
        void chrome.permissions
          .contains({ origins: permissionPatterns(pending.origins) })
          .then(
            (contained) => {
              pending.resolve(granted && contained)
              sendResponse?.(null)
            },
            () => {
              pending.resolve(false)
              sendResponse?.(null)
            },
          )
        return true
      }
    },
  )
}
