# Lighthouse zkTLS integration plan

## Goal

Move the reviewed backend-configurable zkTLS runtime into the active
`lhdao-extension` `dev` line without copying the old standalone extension or
changing production.

The plugin remains generic. Connector rules, website targets and claim logic
come from a signed backend config. A page may only provide a session ID and a
connector ID.

## Scope

One Draft plugin PR against `dev`:

- pin `tlsn-wasm@0.1.0-alpha.15`;
- package its WASM, worker, spawn and snippet assets through WXT;
- add a generic zkTLS runtime, signed-config verifier and strict interpreter;
- add offscreen and permission entrypoints for Chrome and Edge;
- reuse the existing Lighthouse web-presence bridge;
- add typed background messages and focused tests;
- update manifest verification and third-party notices.

No backend deployment, production merge, connector admin UI or Firefox zkTLS
support is part of this PR.

## Fixed plugin boundary

The plugin owns only:

- TLSNotary/WASM execution;
- signed config and ticket verification;
- exact-origin permission requests;
- Cookie capture inside the extension runtime;
- strict request construction and disclosure ranges;
- safe status reporting to the Lighthouse page.

For v3 connectors it also owns a fixed, signed action interpreter that can
wait for a CSS selector, click, input text, or submit a form in the permitted
provider tab before the existing network capture completes. Actions are not
proof claims: the exact signed request matcher and TLS replay remain the only
capture/proof boundary. Arbitrary JavaScript, `eval`, remote scripts, XPath
DOM actions and page-provided actions are unsupported.

The plugin must never accept a verifier endpoint, Cookie/header, connector
config, public key, callback, JavaScript, selector or claim from page input.

## Backend-configured boundary

The backend owns:

- connector ID, revision and interpreter version;
- server name, method, path template and allowed headers;
- response status and extraction rules;
- disclosure rules, nonce and expiry;
- session state and one-time completion;
- trusted verifier webhook interpretation.

Adding a supported website means adding a new signed connector on the backend,
not publishing new plugin code.

## Page contract

Request:

```ts
{
  channel: 'lighthouse-zktls-v1'
  type: 'prove'
  correlationId: string
  sessionId: string
  connectorId: string
}
```

Response:

```ts
{
  channel: 'lighthouse-zktls-v1'
  type: 'prove-result'
  correlationId: string
  status: 'submitted' | 'pending_login' | 'error' | 'unsupported'
  code?: string
}
```

The background validates a top-level sender, the exact compiled Lighthouse web
origin and the verification-page path. Local plugin success never changes the
backend session to `success`.

The content script and background each use an independent runtime parser. Both
parsers require the exact five keys above, enforce the existing identifier
length/character rules, and validate `sender.url` against the compile-time
Lighthouse origin and verification path. TypeScript types are not treated as a
runtime trust boundary.

## Manifest and permissions

Chrome and Edge add:

- `offscreen` and `webRequest` permissions;
- `optional_host_permissions: ['https://*/*']`;
- extension CSP support for the bundled WASM runtime.

The wildcard is permitted only as an optional host permission. Runtime access
is requested for the signed connector's exact origin. Resident host
permissions, content scripts and web-accessible resources remain explicit.

Firefox returns `unsupported` for zkTLS in this phase.

Manifest verification and CI are browser-specific:

- Chrome and Edge require `offscreen`, `webRequest`, the optional HTTPS
  wildcard, WASM CSP and packaged TLSNotary assets;
- Firefox must not receive Chrome-only permissions or assets and must return
  `unsupported`;
- every browser continues to reject wildcard resident host permissions,
  wildcard content scripts and wildcard web-accessible resources.

## Build profiles

zkTLS endpoints and trust roots follow the repository's existing local/product
split and are compiled into the extension. Page input and signed connector data
cannot select or override them.

- local builds use the PR #11 localhost API/verifier profile and a development
  public key;
- product builds require explicit HTTPS API and WSS verifier endpoints plus a
  non-development Ed25519 public key;
- product builds fail closed if localhost, an insecure scheme, a development
  key or a test trust root is present.

## Files

- `package.json`, `pnpm-lock.yaml`
- `wxt.config.ts`
- `modules/tlsn-wasm.ts`
- `src/lib/zktls/**`
- `src/entrypoints/zktls-offscreen/**`
- `src/entrypoints/zktls-permission/**`
- `src/entrypoints/web-presence.content.ts`
- `src/entrypoints/background.ts`
- `src/types/messages.ts`
- `src/lib/messaging.ts`
- `scripts/verify-product-manifests.*`
- `THIRD_PARTY_NOTICES.md` and the applicable TLSNotary license

Build output, `.output`, copied standalone-extension files and development keys
must not be committed.

## Backend dependency before production enablement

The existing `lhdao-service` needs a separate clean PR providing:

- `POST /zktls/v1/sessions`
- `GET /zktls/v1/sessions/:session_id`
- `GET /zktls/v1/signed-config`
- `POST /zktls/v1/verifier/webhook`

Sessions and connectors must be persistent. Only the authenticated verifier
webhook may write success.

Railway later needs an API configuration and a separate constrained verifier
service. The verifier must match the WASM version, use HTTPS/WSS, enforce target
host and concurrency limits, and must not expose the upstream open proxy as-is.

## Acceptance

- frozen install, compile, typecheck, lint and full tests pass;
- Chrome, Edge and Firefox manifest contracts pass;
- Chrome/Edge builds contain non-empty TLSNotary WASM/worker assets;
- non-local builds contain no localhost, development key or test trust root;
- signature, ticket, nonce, connector and sender-origin tampering fail;
- content-script and background parsers reject extra/missing keys, invalid
  identifiers, wrong origins and wrong verification paths independently;
- CI verifies browser-specific manifests and both local/product zkTLS profiles;
- Cookie never reaches page messages, logs, storage or final result;
- existing X, Binance and product-experience tests remain green;
- real Chrome GitHub flow passes through the existing plugin:
  `pending -> authenticated verifier webhook -> success`;
- the PR remains Draft and unmerged until web ChatGPT review explicitly passes.

## Deferred

- persistent backend and connector administration;
- production signing keys and key rotation;
- public constrained verifier deployment;
- callback/receipt delivery;
- Firefox zkTLS runtime;
- XPath: it requires a separately reviewed safe DOM parser/runtime;
- JSONPath worker disclosure: v3 parses only bounded typed scalar paths in the
  independent interpreter. The worker rejects JSON connectors until a later
  transcript byte-range design can prove the disclosed scalar without exposing
  unrelated JSON;
- broader connector semantics beyond the currently implemented strict GET and
  limited JSON/HTML extraction model, except bounded v3 GET/POST matcher,
  selector and provider-action support.
