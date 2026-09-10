# Beta account-preview fix and live validation

## Scope

Correct business-identifier redaction and wallet-output aliases in the previously
approved read/review/confirm flow. Preserve credential redaction, signed rules,
wallet matching, consent and Verifier checks. No campaign publication, funds
operation, dev push, or deployment.

## Reproduction and fix

- The old build redacted `subaccount` and rejected a valid EVM wallet when the
  signed output was named `wallet-1` instead of `walletAddress`.
- Three newly added tests failed with `PRODUCT_ZKTLS_REVIEW_REDACTED` before the
  fix. Recognize subaccount identifiers alongside other business identifiers;
  use signed ACCOUNT_BINDING wallet-output semantics for a valid EVM value,
  retaining sensitive-name and known-secret checks.
- Six added cases cover subaccount extraction, two arbitrary wallet-output
  aliases, sensitive source fields/echoes, and a sensitive wallet-output name.
- 1512 tests across 68 files, TypeScript and scoped Biome passed.

## Packaging

Beta API `https://service.lhdaobeta.top/graphql`, web `https://app.lhdaobeta.top`,
signed config `/zktls/signed-config`, profile `lighthouse-beta-v1` were checked.
The existing Beta Verifier Railway hostname contains `production`; it was not
changed. Chrome manifest verification passed for the Beta endpoint profile.

Package: `/Users/kkruis/Desktop/project/builds/lhdao-extension-0.3.0-beta-review-account-fix-20260910-2208.zip`

SHA256: `3aea6ff04b31ae64db238701db00c7c96da6c46f271b550b2b2a6a1e194d60e5`

The installed unpacked extension ID `pbnjlfelajcidamgnlomloognafchcmo` was updated
in its existing directory and reloaded through Chrome. The original folder was
preserved with suffix `-backup-2208`; connection and Nado permissions remained.

## Real Chrome E2E, 2026-09-10 22:12–22:16 Asia/Shanghai

Existing Beta draft: `cmtv6wxkm0138th0oziwiugk3`, Nado zkTLS 全流程测试 0910.
Rule: 累计入金 ≥ 50, `discovery-rule-2`. No rule edits.
Run correlation: `ea352235-c3ed-46ca-8850-475bd80d373d`.

1. Refreshed the Beta page after extension reload, then re-sent its existing test.
2. Kept Nado connected to the existing OKX wallet; read-only account-menu opening
   triggered `POST https://archive.prod.nado.xyz/v1` for the subaccounts query.
3. Preview displayed 2 subaccounts, the correct request account, and the matching
   response wallet. `wallet-1` was successfully calculated. Confirmation enabled.
4. Clicked confirmation for this account-binding preview (not a deposit preview).
5. `signed-config-checked`, `verifier-session-registered`, `mpc-setup-complete`,
   `proxy-request-started`, `proxy-request-sent`, `tls-transcript-received` observed.
6. Nado returned HTTP/1.1 200, application/json, gzip and chunked transfer encoding.
7. The run failed before reveal with `PROVER_FAILED`; no deposit proof or final
   backend success was observed.

## Remaining boundary

UI reported `request did not match the signed V4 connector`, but the exact
compiled stack location (`worker-BHKNofpR.js:1:3884`) resolves to responseBody's
fixed-length branch, called by v4ResponseDisclosureRanges. The observed response
has `Transfer-Encoding: chunked`, whereas this signed connector took the branch
requiring Content-Length and forbidding Transfer-Encoding. The error string is
shared by request and response parsing and misidentifies this response failure.

Do not remove the response validation or call this proof success. Resolving this
requires checking the signed framing contract and keeping backend configuration,
extension and Verifier behavior consistent; the current local fix does not alter
that contract. The previously observed MPC timeout did not recur in this run.
