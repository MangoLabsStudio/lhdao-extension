# zkTLS V4 Unsafe Candidate Recovery

## Problem

A page can send several requests that match one signed zkTLS V4 request
template. The extension currently reserves the first matching body as the
capture candidate. If that request later contains a forbidden header, such as
`Cookie` or an application-defined `X-*` header, the extension fails the whole
proof session.

Nado exposed this generic race: its normal authenticated poll reached the
signed public endpoint before the extension's safe replay. The body matched,
but the request carried `Cookie` and `X-Nado-Client-Type`. The extension rejected
the headers correctly, then stopped listening before the safe request arrived.

## Decision

When a V4 candidate contains an unsupported header name, discard that candidate
and keep the capture session open. A later request must independently satisfy
the complete signed request contract and the existing public-header allowlist.

This recovery applies to any site. It does not mention Nado, a provider, or a
specific custom header in production code.

## Data Flow

1. `observeBody()` accepts a request only after its tab, frame, initiator,
   target, method, path, query, resource type, body, and signed size limit match.
2. `observe()` inspects header names without reading unsupported header values.
3. If every header name is allowed, the session completes the candidate through
   the existing validation path.
4. If any header name is unsupported, the session clears that candidate's body,
   path, semantic data, and captured variables. It also releases the request ID
   and continues listening.
5. The next request starts from an empty candidate state and must pass every
   check again.

Missing or malformed `requestHeaders` still fails closed because the extension
cannot prove that such a request is public. Redirect overflow, ambiguous
captures, invalid bodies, and all other existing terminal failures remain
terminal.

## Security Invariants

- Keep the current public-header allowlist unchanged.
- Never read, copy, log, store, or replay a forbidden header value.
- Never capture browser credentials, including `Cookie`, `Authorization`, or
  custom authentication headers.
- Clear all candidate-owned data before listening again.
- Accept only a later request that independently matches the signed contract.
- Keep V1 and V3 behavior unchanged.

## Scope

Change only the extension's V4 capture-session handling and its tests. Do not
change Backend, Frontend, Verifier, signed connector schemas, permissions,
storage, or disclosure rules.

## Acceptance Tests

- A matching V4 request with a forbidden header is discarded without throwing;
  the forbidden header value getter is never called.
- `take()` cannot return the discarded request.
- A later request with a different request ID, the same valid signed body, and
  only allowed headers completes successfully.
- The returned capture contains only the later safe request.
- Repeated unsafe candidates do not widen memory, credential, redirect, or
  ambiguity boundaries.
- Missing or non-array V4 headers still fail the session.
- Existing V1 and V3 capture tests remain green.

## Live Success Criterion

On the logged-in Nado page, an authenticated background poll may arrive first
and be discarded. The extension then captures the safe public replay, starts
the proof, and advances beyond the current `unsupported header` failure. Any
later verifier or backend error is diagnosed as a separate stage.
