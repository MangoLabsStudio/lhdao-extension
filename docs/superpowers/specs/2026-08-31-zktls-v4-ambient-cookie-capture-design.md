# zkTLS V4 Ambient Cookie Capture

## Problem

Some public APIs receive browser cookies that the page or edge network adds
automatically. Nado's public history request is one example. The signed V4
connector uses `credentialMode: NONE`, but the extension currently discards
the otherwise exact request as soon as it sees the `Cookie` header. Proof
generation never starts.

## Decision

For V4 capture only, tolerate the presence of an ambient `Cookie` header while
matching the page request. Treat it as trigger-only metadata: check the header
name, do not read its value, and do not copy it into the captured request.

The TLSNotary replay remains credential-free. It continues to contain only the
method, path, body, and public headers derived from the signed connector. If an
endpoint actually requires the ambient cookie, the credential-free replay
fails instead of producing a misleading proof.

Continue to discard candidates that contain `Authorization`, proxy
authorization, CSRF tokens, API keys, signatures, session identifiers, or
unsupported custom headers.

## Security Invariants

- Never read, store, log, upload, disclose, or replay the ambient Cookie value.
- Never place Cookie in `CapturedRequest.secrets` or public proof output.
- Do not widen the signed public-header allowlist.
- Preserve exact method, URL, body, initiator, content type, and signed public
  header matching.
- Preserve all V1 and V3 behavior.
- Add no provider, endpoint, or Nado-specific production logic.

## Scope

Change only the extension V4 request-capture header decision and its tests. Do
not change Backend, Frontend, Verifier, schemas, permissions, storage, or proof
disclosure.

## Acceptance Tests

1. An otherwise exact V4 request with ambient Cookie is captured.
2. A getter-backed Cookie value is never read.
3. The captured result contains no Cookie or secrets.
4. Authorization, CSRF, API-key, session, signature, and arbitrary custom
   headers still discard the candidate without reading their values.
5. Existing V1, V3, request construction, and disclosure tests remain green.
