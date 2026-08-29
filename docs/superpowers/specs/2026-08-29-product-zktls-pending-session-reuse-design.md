# Product zkTLS Pending Session Reuse Design

## Problem

The backend allows only one unexpired pending proof session for a rule. The
extension currently discards that session's ID, connector ID, and expiry when
the prover fails or the extension worker restarts. A later retry asks the
backend to create another session. The backend correctly rejects that request
with `PRODUCT_ZKTLS_PROOF_PENDING`, so the Retry Proof button cannot recover.

## Decision

Reuse a complete, unexpired proof session that the backend already returned.
The extension will retry the prover with the same session ID, connector ID,
and expiry instead of calling the start endpoint again.

A reusable session must have all three fields and an expiry later than the
current time. Missing, malformed, or expired metadata is discarded, and the
extension follows the existing start flow.

## Flow

1. The backend start call returns the signed session metadata.
2. The extension stores it before invoking the prover, as it does today.
3. If the prover throws or returns a retryable error, the queue item returns
   to `queued` but retains complete, unexpired metadata.
4. A later explicit page trigger or Retry Proof action drains the queue.
5. The queue reuses valid metadata and invokes the prover directly. It calls
   the backend start endpoint only when no reusable session exists.
6. A successful prover submission enters the existing backend progress polling
   flow. Backend `PARTIAL` and `VERIFIED` remain authoritative.

Worker recovery follows the same rule. An interrupted `proving` item becomes
`queued`; it retains valid metadata and resumes the prover. It discards stale
or incomplete metadata before requesting a replacement session.

## Failure Boundaries

- A failed backend start call leaves no reusable session.
- `SESSION_EXPIRED` clears the stored session and uses the existing expired
  state.
- Authorization failures keep the existing reauthorization behavior.
- The extension never reuses one rule's session for another rule, campaign,
  task, or Product Experience session.
- The change adds no automatic retry loop. A prover failure still waits for an
  explicit user or page trigger.

## Safety and Compatibility

The reused values came from the backend for the same durable queue item. The
prover still fetches and verifies the signed package for that session. Existing
origin, permission, connector, ticket, verifier, and backend completion checks
remain unchanged.

This change adds no API, database, schema, permission, dependency, public log,
or backend behavior. V1 and V3 behavior remains unchanged.

## Tests

- After a prover error, a later explicit trigger invokes the prover again with
  the same session metadata and does not call the backend start endpoint.
- A thrown prover error has the same retry behavior.
- An interrupted worker resumes with the same complete, unexpired metadata.
- Expired, malformed, or partial metadata is cleared and uses a fresh backend
  start.
- `SESSION_EXPIRED` and authorization failures keep their current behavior.
- Duplicate evidence does not create an automatic retry.
- Existing submitted polling, `PARTIAL`, and `VERIFIED` tests remain green.
