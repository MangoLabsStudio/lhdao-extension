# zkTLS Beta Local Diagnostics Design

## Goal

Expose the exact local proof stage and the data handled by the extension so we
can diagnose the Nado `PROVER_FAILED` result. Keep the diagnostics out of normal
and production builds.

## Build boundary

- Add one compile-time flag: `WXT_ZKTLS_DEBUG=true`.
- Emit diagnostics only when this flag is exactly `true` and the existing zkTLS
  profile targets Lighthouse Beta.
- Keep the flag off by default. Production and ordinary Beta builds contain no
  active diagnostic output.
- Do not add a runtime switch, storage field, dependency, server endpoint, or
  database write.

## Diagnostic output

The offscreen proof worker writes one ordered trace to its local DevTools
console. Each entry includes the proof correlation ID and a stage name:

1. captured request received;
2. signed config checked;
3. verifier registration completed;
4. proxy request sent;
5. TLS transcript received;
6. response framing decoded;
7. gzip decoded;
8. strict JSON checked;
9. transcript reveal submitted;
10. completion received or failure returned.

For the request, print the URL, method, public headers, content type, JSON body,
resource type, and captured variable slots. For the response, print the status
line, response headers, wire byte count, compressed byte count, decoded byte
count, and decoded JSON. Print the exception name, message, stack, and last
completed stage on failure.

## Credential handling

Never print credential values. Replace values for `cookie`, `set-cookie`,
`authorization`, `proxy-authorization`, plugin tokens, and captured secret
headers with an object containing only `present: true` and `length`. Apply the
same rule before printing nested captured request data or raw HTTP text.

The trace remains in the local extension DevTools console. The extension does
not send it to Lighthouse, Railway, the verifier, analytics, or browser
storage. Reloading the extension or closing DevTools discards the trace.

## Failure behavior

Diagnostics must not change proof input, validation, disclosure, retry, or
completion behavior. Logging failures are ignored. The existing public error
code remains `PROVER_FAILED`.

## Tests

- A disabled build emits nothing.
- A Beta debug build emits stages in order.
- Sanitization removes credential values from headers, nested objects, and
  thrown errors while preserving public request and response JSON.
- A diagnostic exception cannot fail a proof.
- Existing zkTLS worker, parser, privacy, type-check, and production build gates
  remain green.

## Acceptance test

Build the unpacked Beta extension with `WXT_ZKTLS_DEBUG=true`, reload it, open
the offscreen worker DevTools console, and run the Nado proof once. The trace
must identify the last successful stage and the exact local exception without
exposing a credential value.
