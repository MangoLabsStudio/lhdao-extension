# zkTLS Proof Failure Code Design

## Problem

The Product Check card reduces every zkTLS proof failure to
`VERIFICATION_FAILED`. The controller discards the runtime's stable error code,
so a buyer cannot distinguish capture failure, prover failure, or timeout.
Backend sessions remain pending because these failures occur before a verifier
completion callback.

## Decision

Keep one optional, allowlisted zkTLS failure code in the extension's temporary
Product Experience session. Copy only known runtime codes. Map unknown values to
`ZKTLS_UNKNOWN_FAILURE`; never retain raw exception messages.

Expose this code only in the extension popup's Product Check card. Do not add it
to the public page bridge, backend API, proof payload, or durable Product state.
The card shows one short line, for example `错误码：PROVER_TIMEOUT`, when the
public error is `VERIFICATION_FAILED`.

Clear the code when a proof starts, succeeds, requires authorization, expires,
or the session is cleared. A retry may replace it only with the next allowlisted
failure code.

## Safe Codes

The allowlist covers the current runtime boundary:

- `ZKTLS_CAPTURE_FAILED`
- `ZKTLS_SETUP_FAILED`
- `PROVER_BUSY`
- `PROVER_FAILED`
- `PROVER_TIMEOUT`
- `REQUEST_NOT_CAPTURED`
- `UNSUPPORTED_CONNECTOR`
- `ZKTLS_BUSY`
- `ZKTLS_UNKNOWN_FAILURE`

Authorization and expiry retain their existing public states and do not show a
proof failure code.

## Tests

1. A runtime `PROVER_TIMEOUT` failure remains retryable and reaches controller
   state as the same safe code.
2. An unknown runtime code becomes `ZKTLS_UNKNOWN_FAILURE`.
3. Retry/start and successful submission clear stale codes.
4. The Product Check card displays the safe code only for a retryable proof
   failure.
5. Existing public bridge serialization remains unchanged.

## Non-goals

- Raw exception messages, headers, request bodies, responses, cookies, tokens,
  tickets, or verifier payloads.
- Backend schema, API, or database changes.
- New logging, telemetry, or dependencies.
