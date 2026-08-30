# zkTLS ticket clock-skew design

## Problem

The Beta backend can issue a signed ticket a few milliseconds ahead of the
browser clock. The extension currently rejects any ticket whose `issued_at` is
later than the browser's current time. It therefore fails before opening the
Verifier WebSocket even though the ticket, digest, and signatures are valid.

## Decision

Allow at most five seconds of positive clock skew when checking `issued_at`.
Keep `expires_at` strict: a ticket is unavailable as soon as the browser clock
reaches its expiry.

Apply the rule in the shared `assertTicketAvailable` function so signed-config
loading, runtime checks, and the offscreen worker use the same boundary. Do not
change the backend, Verifier, ticket lifetime, signatures, or replay checks.

## Tests

- Accept a ticket when the browser clock is up to five seconds behind
  `issued_at`.
- Reject a ticket when the browser clock is more than five seconds behind.
- Reject a ticket at `expires_at` and after it.
- Run the focused zkTLS suite, full test suite, typecheck, formatter/linter,
  Chrome build, and diff check before rebuilding the Beta extension.
