import type { CapturedRequest } from './capture'
import {
  BODY_LIMIT,
  byteLength,
  type Json,
  jsonBody,
  observationSecrets,
  REDACTED,
  redact,
  redactUrl,
  safeClone,
  sensitiveKey,
} from './discovery/redaction'
import type { V4Connector, V4ResolvedVariable } from './interpreter'
import {
  evaluateProductZkTlsPipeline,
  hasProductZkTlsPreviewRows,
  productZkTlsPipelineUsesMarker,
} from './preview-pipeline'
import type { ProofReviewSnapshot } from './review'

export type ProofReviewInput = {
  connector: V4Connector
  captured: CapturedRequest
  requestHeaders?: Record<string, string>
  response: {
    text?: string
    contentType?: string
    status?: number
    headers?: Record<string, string>
  }
  expectedWallet: string | null
  pageUrl: string
  id: string
  title: string
  expiresAt: number
  capturedAt?: number
}

function evmAddress(value: unknown): string | null {
  return typeof value === 'string' &&
    /^0x[\da-f]{40}$/i.test(value) &&
    !/^0x0{40}$/i.test(value)
    ? value.toLowerCase()
    : null
}

function exceedsCollectionLimit(value: Json): boolean {
  if (Array.isArray(value))
    return value.length > 200 || value.some(exceedsCollectionLimit)
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.values(value).some(exceedsCollectionLimit)
  )
}

/** Local, unverified preview. No network, persistence, authoring, or verifier state. */
export function buildProofReviewSnapshot(
  input: ProofReviewInput,
): ProofReviewSnapshot {
  const { connector, captured } = input
  const requestUrl = `${connector.origin}${captured.path}`
  const secrets = observationSecrets({
    requestHeaders: input.requestHeaders ?? captured.secrets,
    responseHeaders: input.response.headers,
    requestBody: captured.body,
    responseBody: input.response.text,
    url: requestUrl,
    documentUrl: input.pageUrl,
  })
  const text = (value: string, key = '') => String(redact(value, key, secrets))
  const page = redactUrl(input.pageUrl, secrets)
  const request = redactUrl(requestUrl, secrets)
  const body = jsonBody(input.response.text, secrets)
  const requestBody =
    captured.body === undefined ? null : jsonBody(captured.body, secrets).value
  const expected = evmAddress(input.expectedWallet)
  const safeExpected =
    expected && text(expected, 'walletAddress') === expected ? expected : null
  const snapshot: ProofReviewSnapshot = {
    // Opaque extension-generated nonce, not captured website data.
    id: input.id,
    connectorId: text(connector.connector_id),
    title: text(input.title),
    pageOrigin: page?.origin ?? '',
    pagePath: page?.path ?? '',
    targetOrigin: request?.origin ?? '',
    requestPath: request?.path ?? '',
    method: captured.method ?? connector.request.method,
    capturedAt: input.capturedAt ?? Date.now(),
    expiresAt: input.expiresAt,
    requestAccounts: [],
    account: {
      observed: null,
      expected: safeExpected,
      status: 'unknown',
      source:
        connector.purpose === 'ACCOUNT_BINDING'
          ? 'response'
          : 'verified-binding',
    },
    request: { query: request?.query ?? null, body: requestBody },
    response: body.value,
    responseState: body.state,
    values: [],
    canConfirm: false,
    error: null,
  }
  const reject = (error: string, state = snapshot.responseState) => {
    snapshot.error = error
    snapshot.responseState = state
    snapshot.values = []
    return snapshot
  }

  if (
    !page ||
    !request ||
    page.origin !== connector.page_origin ||
    request.origin !== connector.origin ||
    !Number.isFinite(snapshot.expiresAt) ||
    snapshot.expiresAt <= Date.now()
  )
    return reject('PRODUCT_ZKTLS_REVIEW_CONTEXT_INVALID')
  if (body.state !== 'json') {
    // A declared JSON response beginning like JSON but failing parsing is malformed.
    const malformed =
      body.state === 'non-json' && /^\s*[[{]/.test(input.response.text ?? '')
    return reject(
      `PRODUCT_ZKTLS_REVIEW_${malformed ? 'INVALID' : body.state.toUpperCase()}`,
      malformed ? 'invalid' : body.state,
    )
  }
  const limit = Math.min(
    BODY_LIMIT,
    connector.max_decoded_data ?? connector.request.max_recv_data,
  )
  if (
    byteLength(input.response.text!) > limit ||
    exceedsCollectionLimit(body.value) ||
    (safeClone(body.value, BODY_LIMIT, 4096, 12) === null &&
      body.value !== null)
  ) {
    snapshot.response = null
    return reject('PRODUCT_ZKTLS_REVIEW_OVERSIZE', 'oversize')
  }
  if (input.response.status !== connector.response_status)
    return reject('PRODUCT_ZKTLS_REVIEW_HTTP_STATUS', 'invalid')
  if (
    !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(
      input.response.contentType ?? '',
    )
  )
    return reject('PRODUCT_ZKTLS_REVIEW_NON_JSON', 'non-json')

  const variables: Record<string, V4ResolvedVariable> = Object.create(null)
  for (const declaration of connector.variables) {
    const resolved =
      declaration.source.kind === 'CAPTURED_REQUEST'
        ? {
            type: declaration.scalarType,
            value: captured.capturedVariables?.[declaration.name],
          }
        : connector.resolved_variables[declaration.name]
    if (
      !resolved ||
      resolved.type !== declaration.scalarType ||
      (typeof resolved.value !== 'string' &&
        typeof resolved.value !== 'boolean') ||
      resolved.value === ''
    )
      return reject('PRODUCT_ZKTLS_REVIEW_VARIABLE_UNKNOWN')
    const safe = redact(resolved.value, declaration.name, secrets)
    // Account IDs are business data, while credential names and known secrets stay hidden.
    const account =
      declaration.source.kind === 'BOUND_ACCOUNT' ||
      (connector.purpose === 'ACCOUNT_BINDING' &&
        connector.account_binding.accountVariable === declaration.name)
    const safeValue = account
      ? redact(resolved.value, 'accountId', secrets)
      : safe
    if (
      sensitiveKey(declaration.name) ||
      (safe === REDACTED && !account) ||
      safeValue === REDACTED
    )
      return reject('PRODUCT_ZKTLS_REVIEW_VARIABLE_REDACTED')
    variables[declaration.name] = resolved as V4ResolvedVariable
    if (account)
      snapshot.requestAccounts.push({
        name: text(declaration.name),
        value: String(safeValue),
      })
  }
  try {
    if (!connector.pipelines.length)
      return reject('PRODUCT_ZKTLS_REVIEW_PIPELINE_MISSING', 'invalid')
    const values = connector.pipelines.map((pipeline) => {
      if (productZkTlsPipelineUsesMarker(pipeline, body.value, REDACTED))
        throw new Error('PRODUCT_ZKTLS_REVIEW_REDACTED')
      if (!hasProductZkTlsPreviewRows(pipeline, body.value, variables))
        throw new Error('PRODUCT_ZKTLS_REVIEW_EMPTY')
      const result = evaluateProductZkTlsPipeline(
        pipeline,
        body.value,
        variables,
      )
      const safeValue = text(String(result.value), pipeline.output)
      if (safeValue === REDACTED)
        throw new Error('PRODUCT_ZKTLS_REVIEW_REDACTED')
      return {
        output: text(pipeline.output),
        value: safeValue,
        unit: result.unit ? text(result.unit) : null,
      }
    })
    if (connector.purpose === 'ACCOUNT_BINDING') {
      const wallet = values.filter(
        (value) => value.output === connector.account_binding.walletOutput,
      )
      snapshot.account.observed =
        wallet.length === 1 ? evmAddress(wallet[0].value) : null
    } else {
      const bound = connector.variables.filter(
        (variable) => variable.source.kind === 'BOUND_ACCOUNT',
      )
      // These values were embedded by the backend after verified binding resolution.
      if (
        bound.length &&
        bound.every(
          (variable) =>
            typeof variables[variable.name]?.value === 'string' &&
            variables[variable.name].value !== '',
        )
      ) {
        snapshot.account.observed = safeExpected
      }
    }
    snapshot.account.status =
      snapshot.account.observed && safeExpected
        ? snapshot.account.observed === safeExpected
          ? 'matched'
          : 'mismatch'
        : 'unknown'
    snapshot.values = values
    snapshot.canConfirm = snapshot.account.status === 'matched'
    if (!snapshot.canConfirm)
      snapshot.error = `PRODUCT_ZKTLS_REVIEW_WALLET_${snapshot.account.status.toUpperCase()}`
    return snapshot
  } catch (error) {
    const code =
      error instanceof Error && /^PRODUCT_ZKTLS_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'PRODUCT_ZKTLS_REVIEW_CALCULATION_INVALID'
    return reject(
      code,
      code === 'PRODUCT_ZKTLS_REVIEW_EMPTY' ||
        code === 'PRODUCT_ZKTLS_PIPELINE_UNIQUE_EMPTY'
        ? 'empty'
        : 'invalid',
    )
  }
}
