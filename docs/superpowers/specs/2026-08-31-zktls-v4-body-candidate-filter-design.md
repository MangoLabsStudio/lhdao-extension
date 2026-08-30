# zkTLS V4 Body Candidate Filter

## Problem

Some APIs multiplex several operations through one HTTP method and path. Nado,
for example, sends unrelated background POST requests to the same `/v1` path as
the signed request. The extension currently reserves the first request whose
method, origin, path, query, and resource type match. It validates the body only
after the request headers arrive. A well-formed but unrelated body therefore
ends the whole capture with `ZKTLS_CAPTURE_FAILED` before the signed operation
can occur.

## Decision

For V4 POST requests, validate the body against the signed template inside
`observeBody()` before reserving the request as a candidate. A well-formed body
that does not match is unrelated traffic: ignore it and keep listening. A later
request must independently satisfy the complete signed request contract.

Malformed bodies remain terminal. The extension must still fail closed for
invalid UTF-8, invalid JSON, duplicate keys, excessive size or complexity, and
other strict-parser violations. Header validation, redirect tracking,
ambiguity detection, sent-byte limits, and disclosure validation remain
unchanged.

## Security Invariants

- Do not weaken or alter the signed request template.
- Do not accept or disclose a body that fails the template.
- Ignore only a well-formed body whose matcher returns no exact match.
- Preserve terminal failure for malformed or unsafe request data.
- Keep V1 and V3 behavior unchanged.
- Add no provider, endpoint, operation, or Nado-specific production logic.

## Scope

Change only `CaptureSession.observeBody()` and its V4 capture tests. Do not
change Backend, Frontend, Verifier, signed schemas, permissions, storage, or
proof disclosure.

## Acceptance Test

1. A same-path V4 POST with a valid JSON body that does not match the signed
   template is ignored without completing or failing the capture.
2. A later same-path POST with the exact signed body is captured normally.
3. The returned capture contains only the later request and its variables.
4. Existing malformed-body, duplicate-candidate, V1, and V3 tests remain green.

