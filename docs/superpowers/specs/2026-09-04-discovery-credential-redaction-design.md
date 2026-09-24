# Discovery Credential Redaction Design

## Goal

Let buyers inspect and select captured business values in the local discovery
workbench without exposing credentials that can authorize requests or take over
a session.

## Boundary

The extension keeps captured samples in memory and sends only the filtered copy
to the Lighthouse page. The page does not persist or upload those samples. A
stopped or replaced discovery session discards them.

The filter always masks credential-bearing keys, including cookies,
authorization headers, access and refresh tokens, API keys, passwords, secrets,
request signatures, private keys, HMAC keys, session credentials, and CSRF
tokens. Known credential values also remain masked when an API echoes them under
another key.

Ordinary identifiers are visible in the local sample. This includes wallet
addresses, account identifiers, and generic record identifiers. Existing
business values such as amounts, volumes, balances, status values, and dates
remain visible.

## Implementation

Keep one mirrored filtering function in the extension and frontend trust
boundaries. Narrow `sensitiveKey` to credentials. Allow identifier-shaped values
when their field name identifies a wallet, account, address, or record ID. Keep
the existing dynamic-value masking for unknown keys so opaque secrets do not
become visible by accident.

No backend, database, verifier, persistence, export, reveal button, or new
configuration is required.

## Verification

Unit tests must prove that business identifiers remain visible, every approved
credential key remains masked, and echoed credential values remain masked. The
extension and frontend must apply the same rules. Run their focused tests,
typechecks, and production-equivalent dev builds.
