# Signed automatic response framing — 2026-09-10

## Failure and scope

The last Beta Nado account-binding run reached MPC setup and received HTTP/1.1
200 JSON, gzip, chunked. Its signed connector had no response framing field,
which means fixed Content-Length. The extension rejected the response before
reveal. Browser discovery headers had incorrectly been used to choose the
framing required for the proof replay.

This change adds explicitly signed automatic framing; it does not change the
deposit threshold, account binding, wallet, request matching, or campaign state.
Existing preview/redaction fixes in the extension worktree are included in the
new package.

## Contract

- Authoring: `response.transferEncoding: "AUTO"`.
- Signed V4 connector: `response_transfer_encoding: "auto"`.
- New discovery connectors use AUTO. Existing saved connectors are not migrated.
- AUTO uses strict chunked decoding when Transfer-Encoding is present;
  otherwise it requires a strict Content-Length response.
- Only HTTP/1.1 and exact chunked transfer encoding are accepted for chunking.
  Duplicate/conflicting framing, truncation, invalid JSON, and existing byte
  limits remain enforced. Compression is still independently signed.
- Existing CHUNKED and absent/fixed modes retain their behavior.
- Frontend, backend policy/compiler/disclosure, extension, and Rust Verifier
  all support the explicit new field. Changes to the signed mode invalidate
  the configuration signature.

## Verified locally

- Extension: 68 suites / 1513 tests; TypeScript check; Beta build and manifest
  environment verification.
- Backend: five scoped suites / 637 tests; TypeScript check; changed-file Biome.
- Frontend: three scoped suites / 214 tests; TypeScript check; changed-file Biome.
- Verifier: cargo test, 116 main tests plus 11 binary tests.
- Regression fixtures cover fixed/chunked crossed with identity/gzip, plus
  conflicting lengths and truncated bodies. The existing frozen fixture is
  unchanged. New behavior tests were observed failing before implementation.
- Git diff whitespace checks pass in all four worktrees.

## Beta artifact

`/Users/kkruis/Desktop/project/builds/lhdao-extension-0.3.0-beta-auto-framing-20260910-2237.zip`

SHA256: `90c897ef3a880f72cc13e94d5b1a9cdab21dd550c3823b644a13952d662a8a81`

API: `https://service.lhdaobeta.top/graphql`.
Web: `https://app.lhdaobeta.top`.
Verifier profile: `lighthouse-beta-v1`.
The configured Railway verifier hostname contains `production`; this is the
existing Beta profile endpoint, not a change to the production application.

## Rollout and next live test

No code was pushed or deployed during this turn. No Chrome extension was
reloaded. This is not a completed live proof.

1. Publish and deploy supporting backend and Verifier, and install the matching
   Beta extension before enabling new AUTO configurations in the frontend.
2. Deploy frontend. Open the existing Nado draft and explicitly change each
   relevant connector's response framing to AUTO, then save it. Do not alter
   the cumulative deposit threshold or account binding business rules.
3. Start a new test session so the backend signs the new configuration; do not
   reuse a previous session/ticket or assume a saved legacy draft was migrated.
4. Inspect preview, account match, MPC, framing/gzip/JSON, reveal, Verifier result,
   backend acceptance, then the deposit rule. Record each actual boundary.

Older Verifiers/plugins intentionally reject the unknown AUTO field. Merely
installing this package cannot change an old server-signed fixed-length policy.
