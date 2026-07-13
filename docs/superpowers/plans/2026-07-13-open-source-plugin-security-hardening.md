# Open-source Plugin Security Hardening Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Use `test-driven-development` for every behavior change and `verification-before-completion` before each commit.

**Goal:** 在不改变插件正常 UI、业务流程、奖励规则和 GraphQL 返回结构的前提下，为开源插件增加固定操作清单、设备签名、防重放、限流、资金操作幂等和服务端动作核验；评论完全未捕获时允许用户在主站提交评论 URL 作为证据。

**Architecture:** 保留现有 `/graphql` 和 plugin token Bearer 鉴权。后端新增独立 `plugin-security` 模块，在 JWT 鉴权之后按 operation manifest 校验请求文档、设备签名、时间窗、nonce 和限流。插件在 background service worker 中持有不可导出的 P-256 私钥并统一签名 GraphQL 请求。动作捕获仅作为线索，最终完成状态由后端 Twitter 校验决定。资金类写操作用数据库幂等记录包住扣款和业务写入。

**Tech Stack:** NestJS 11、GraphQL/Apollo、Prisma 6/PostgreSQL、Redis、Next.js 16/React 19、WXT MV3、Web Crypto ECDSA P-256、Vitest/Jest。

---

## Scope and invariants

- 插件允许的 13 个业务操作：`CreateExtensionPairing`、`PollExtensionPairing`、`Me`、`AvailableEngagements`、`MyReservedEngagements`、`AvailableTweets`、`LighthouseMembers`、`RecordTweetDwell`、`ReportEngagementCapture`、`MintEngagementTicket`、`SubmitEngagementProof`、`PromoteTweet`、`CreateAutoReinvestTask`。
- 主站配套操作：`CompleteExtensionPairing`、`ReserveEngagementSlot`、`SubmitEngagementCommentEvidence`，都必须走 Cookie/JWT，不能用 plugin token。
- 删除插件中已被后端拒绝且不可工作的旧调用：`ReserveEngagementSlot`、`VerifyEngagement`、`MintWatermarkToken`。
- 正常捕获成功时不新增步骤；只有评论完全未捕获或无法取得结果推文 ID 时，主站才显示评论 URL 证据入口。
- `PASS`、HMAC、停留时长和客户端捕获都不能直接发奖；服务端 Twitter 校验通过后才能推进验证/发奖。
- 后端和前端现有工作区都有无关 WIP；实施分支必须从 `origin/dev` 建隔离 worktree。插件 WIP 要复制到隔离 worktree 并先形成单独基线提交，原目录保持不动。

## Task 0: Freeze baselines without touching current WIP

**Files:**

- Create worktrees under `/Users/kkruis/Desktop/project/.worktrees/plugin-security/`
- No product files changed in the current three working directories

**Step 1: Record exact starting state**

Run:

```bash
git -C /Users/kkruis/Desktop/project/backend status --short --branch
git -C /Users/kkruis/Desktop/project/frontend status --short --branch
git -C /Users/kkruis/Desktop/project/lhdao-extension status --short --branch
```

Expected: backend/frontend/extension dirty files match the handoff inventory. Stop if a new overlapping change appears.

**Step 2: Create clean backend and frontend worktrees from current remote dev**

Run:

```bash
git -C /Users/kkruis/Desktop/project/backend fetch origin dev
git -C /Users/kkruis/Desktop/project/backend worktree add -b feat/plugin-security-backend /Users/kkruis/Desktop/project/.worktrees/plugin-security/backend origin/dev
git -C /Users/kkruis/Desktop/project/frontend fetch origin dev
git -C /Users/kkruis/Desktop/project/frontend worktree add -b feat/plugin-security-frontend /Users/kkruis/Desktop/project/.worktrees/plugin-security/frontend origin/dev
```

Expected: both worktrees are clean and point at fetched `origin/dev`.

**Step 3: Create extension worktree and overlay the current WIP**

Create a worktree from `feat/engagement-capture`, then copy only the current working tree contents, excluding `.git`, `.output`, `node_modules`, and docs plan/spec files already committed. Verify `git diff --stat` matches the original extension WIP.

**Step 4: Test and commit the extension WIP baseline separately**

Run in the isolated extension worktree:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all pass. Commit only the existing feature WIP as:

```bash
git commit -m "feat(extension): complete engagement capture workflow"
```

Do not include any security-hardening code in this baseline commit.

## Task 1: Define and test the fixed operation protocol

**Backend files:**

- Create: `backend/src/modules/plugin-security/operation-manifest.ts`
- Create: `backend/src/modules/plugin-security/operation-manifest.spec.ts`
- Create: `backend/src/modules/plugin-security/canonical-json.ts`
- Create: `backend/src/modules/plugin-security/canonical-json.spec.ts`

**Extension files:**

- Create: `lhdao-extension/src/lib/plugin-operations.ts`
- Create: `lhdao-extension/src/lib/__tests__/plugin-operations.test.ts`
- Modify: `lhdao-extension/src/lib/queries.ts`

**Step 1: Write failing canonicalization tests**

Cover recursive key sorting, array order preservation, `null`, booleans, numbers, omitted `undefined`, Unicode, and stable SHA-256 output. The backend and extension fixtures must contain the same variables and expected hash.

**Step 2: Implement canonical JSON and SHA-256 helpers**

Expose this contract on both sides:

```ts
canonicalJson(value: unknown): string
sha256Hex(value: string): Promise<string> | string
```

Reject non-JSON values instead of silently stringifying them.

**Step 3: Write failing manifest tests**

Each manifest item must contain:

```ts
interface PluginOperationDefinition {
  id: string
  operationName: string
  documentSha256: string
  permission: 'public' | 'read' | 'capture' | 'verify' | 'spend'
  version: 1
}
```

Tests must prove all 13 operations are present, IDs and names are unique, and changing a field or alias changes `documentSha256`.

**Step 4: Implement the manifests**

Keep the current GraphQL documents unchanged. Compute hashes from their exact UTF-8 source. The extension lookup is by document identity/operation name; the backend lookup is by `x-plugin-operation-id`.

**Step 5: Remove dead extension documents and imports**

Delete `RESERVE_SLOT_MUTATION`, `VERIFY_ENGAGEMENT_MUTATION`, `MINT_WATERMARK_TOKEN_QUERY` and the legacy paths that call them. Keep the current ticket/proof path.

**Step 6: Verify and commit independently in each repo**

Run focused tests, typecheck, then commit:

```bash
git commit -m "feat(plugin-security): define fixed operation manifest"
git commit -m "feat(extension): sign only declared plugin operations"
```

## Task 2: Add device registration and pairing binding

**Backend files:**

- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_add_plugin_devices/migration.sql`
- Create: `backend/src/modules/plugin-security/plugin-device.service.ts`
- Create: `backend/src/modules/plugin-security/plugin-device.service.spec.ts`
- Create: `backend/src/modules/plugin-security/dto/register-plugin-device.input.ts`
- Create: `backend/src/modules/plugin-security/plugin-security.resolver.ts`
- Modify: `backend/src/modules/plugin-token/extension-pairing.service.ts`
- Modify: `backend/src/modules/plugin-token/plugin-token.resolver.ts`
- Modify: `backend/src/modules/plugin-token/dto/extension-pairing.model.ts`

**Extension files:**

- Create: `lhdao-extension/src/lib/device-key.ts`
- Create: `lhdao-extension/src/lib/__tests__/device-key.test.ts`
- Modify: `lhdao-extension/src/lib/storage.ts`
- Modify: `lhdao-extension/src/lib/queries.ts`
- Modify: `lhdao-extension/src/entrypoints/background.ts`

**Step 1: Add failing service tests**

Cover valid P-256 public JWK, malformed/other-curve JWK rejection, unique `(pluginTokenId, deviceId)`, revoked device rejection, token revocation cascading to device denial, and one-time legacy registration limits.

**Step 2: Add the Prisma model**

```prisma
model PluginDevice {
  id              String   @id @default(cuid())
  userId          String
  pluginTokenId   String
  deviceId        String   @db.VarChar(64)
  publicKeyJwk    Json
  status          String   @default("ACTIVE") @db.VarChar(16)
  createdAt       DateTime @default(now()) @db.Timestamptz
  lastUsedAt      DateTime? @db.Timestamptz
  revokedAt       DateTime? @db.Timestamptz
  user            User @relation(fields: [userId], references: [id], onDelete: Cascade)
  pluginToken     PluginAccessToken @relation(fields: [pluginTokenId], references: [id], onDelete: Cascade)

  @@unique([pluginTokenId, deviceId])
  @@index([userId, status])
  @@map("plugin_devices")
}
```

Add reverse relation fields to `User` and `PluginAccessToken`.

**Step 3: Bind new pairing flows**

`CreateExtensionPairing` receives `deviceId` and `publicKeyJwk`; Redis stores them in the pending record. `CompleteExtensionPairing` creates the plugin token and `PluginDevice` in one database transaction. `PollExtensionPairing` returns the same existing token shape.

**Step 4: Implement the legacy bridge**

Add plugin-token-only `RegisterPluginDevice`. Allow once per token, at most 3 attempts/day, only during audit mode, and reject anomalous/banned IPs. It is a migration endpoint, not part of the permanent 13-operation manifest; remove/disable it before enforce mode.

**Step 5: Implement extension key storage**

Generate with:

```ts
crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign', 'verify'],
)
```

Store the non-extractable private `CryptoKey` in IndexedDB and the public JWK/device ID in typed local storage. Never place the private key in `chrome.storage`.

**Step 6: Verify pairing compatibility**

Run backend Jest tests, extension Vitest tests, and manually exercise create → web complete → poll → signed `Me` in audit mode.

**Step 7: Commit**

```bash
git commit -m "feat(plugin-security): bind plugin tokens to device keys"
git commit -m "feat(extension): create device key during pairing"
```

## Task 3: Enforce document hash, signature, timestamp, nonce, and modes

**Backend files:**

- Create: `backend/src/modules/plugin-security/plugin-request-security.service.ts`
- Create: `backend/src/modules/plugin-security/plugin-request-security.service.spec.ts`
- Create: `backend/src/modules/plugin-security/plugin-security.guard.ts`
- Create: `backend/src/modules/plugin-security/plugin-security.module.ts`
- Create: `backend/src/modules/plugin-security/plugin-security.errors.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/src/guard/auth/jwt.guard.ts`
- Modify: `backend/src/modules/plugin-token/plugin-token.service.ts`

**Extension files:**

- Create: `lhdao-extension/src/lib/request-signing.ts`
- Create: `lhdao-extension/src/lib/__tests__/request-signing.test.ts`
- Modify: `lhdao-extension/src/lib/gql.ts`

**Step 1: Add failing signature fixture tests**

Use a fixed test key and assert both repositories accept the same canonical message:

```text
lhdao-plugin-v1
<operationId>
<documentSha256>
<variablesSha256>
<deviceId>
<timestamp>
<nonce>
```

Test tampered document, variables, device ID, timestamp and nonce.

**Step 2: Implement the extension signer**

For every declared operation, add:

```text
x-plugin-operation-id
x-device-id
x-request-timestamp
x-request-nonce
x-device-signature
```

Signature encoding must be one documented base64url format. Retries create a new nonce/signature except idempotent spend retries, which reuse only the idempotency key.

**Step 3: Implement backend guard in audit mode**

Register `PluginSecurityGuard` after `JwtAuthGuard`. It applies only to plugin Bearer requests and anonymous pairing requests carrying a plugin operation ID. It reads `req.body.query` and `req.body.variables`, computes both hashes, verifies the P-256 signature, and records a structured audit result.

Modes:

- `audit`: unsigned legacy requests continue but are logged; invalid signed requests are rejected.
- `enforce`: all plugin operations require manifest + active device + valid signature.
- `emergency-read-only`: only `public` and `read` permissions pass.

Environment variable: `PLUGIN_SECURITY_MODE=audit|enforce|emergency-read-only`, default `audit` until rollout completes.

**Step 4: Add timestamp and nonce replay protection**

- Timestamp skew: ±120 seconds.
- Redis key: `plugin:req:{pluginTokenId}:{deviceId}:{nonce}`.
- Atomic `SET NX EX 300`; a miss is `PLUGIN_REQUEST_REPLAY`.
- Do not consume nonce until document, variables and signature have passed.

**Step 5: Return stable errors**

Implement: `PLUGIN_SECURITY_REQUIRED`, `PLUGIN_DEVICE_DENIED`, `PLUGIN_OPERATION_DENIED`, `PLUGIN_REQUEST_EXPIRED`, `PLUGIN_REQUEST_REPLAY`, `PLUGIN_SIGNATURE_INVALID`.

**Step 6: Verify normal JWT traffic is untouched**

Tests must assert cookie/JWT GraphQL requests without plugin headers behave exactly as before, public health endpoints are untouched, and plugin token requests cannot escape the fixed manifest even when a resolver still has `@AllowPluginToken()`.

**Step 7: Commit**

```bash
git commit -m "feat(plugin-security): verify signed allowlisted requests"
git commit -m "feat(extension): sign GraphQL requests with device key"
```

## Task 4: Add permission-aware rate limits and silent backoff

**Backend files:**

- Create: `backend/src/modules/plugin-security/plugin-rate-limit.service.ts`
- Create: `backend/src/modules/plugin-security/plugin-rate-limit.service.spec.ts`
- Modify: `backend/src/modules/plugin-security/plugin-security.guard.ts`

**Extension files:**

- Modify: `lhdao-extension/src/lib/gql.ts`
- Modify: `lhdao-extension/src/entrypoints/background.ts`
- Create: `lhdao-extension/src/lib/__tests__/gql-backoff.test.ts`

**Step 1: Write failing window/identity tests**

Initial limits:

- create pairing: 10/min/IP
- poll pairing: 40/min/code and 120/min/IP
- read: 30/min/device/operation
- `LighthouseMembers`: 120/min/device
- capture: 120/min/device/operation
- ticket/proof: 10/min/user/campaign/operation
- spend: 5/min/user/operation

**Step 2: Implement atomic Redis counters**

Use Lua or an existing atomic Redis primitive. Return HTTP 429, GraphQL error code `PLUGIN_RATE_LIMITED`, and `Retry-After`.

**Step 3: Implement extension backoff**

Respect `Retry-After`, add jitter, coalesce duplicate background sync calls, and do not show a normal-user error toast for background polling throttles.

**Step 4: Verify and commit**

```bash
git commit -m "feat(plugin-security): rate limit plugin operations"
git commit -m "fix(extension): back off on plugin security throttles"
```

## Task 5: Capture the created comment tweet ID

**Extension files:**

- Modify: `lhdao-extension/src/lib/engagement-capture.ts`
- Modify: `lhdao-extension/src/entrypoints/capture.content.ts`
- Modify: `lhdao-extension/src/entrypoints/capture-bridge.content.ts`
- Modify: `lhdao-extension/src/entrypoints/background.ts`
- Modify: `lhdao-extension/src/lib/storage.ts`
- Modify: `lhdao-extension/src/lib/queries.ts`
- Modify: `lhdao-extension/src/lib/__tests__/engagement-capture.test.ts`
- Modify: `lhdao-extension/src/lib/__tests__/proof.test.ts`

**Backend files:**

- Modify: `backend/src/modules/plugin-verify/dto/submit-engagement-proof.input.ts`
- Modify: `backend/src/modules/plugin-verify/plugin-verify.service.ts`
- Modify: `backend/src/modules/plugin-verify/plugin-verify.spec.ts`
- Modify: `backend/src/modules/unified-campaign/service/plugin-verdict-source.service.ts`

**Step 1: Add failing response parsing tests**

Cover `CreateTweet` and `CreateNoteTweet` response variants. The captured action must distinguish:

```ts
{
  actionType: 'COMMENT'
  tweetId: '<target tweet id>'
  resultTweetId: '<new reply tweet id>'
  commentText?: string
}
```

Never infer `resultTweetId` from the request body.

**Step 2: Parse successful response bodies in the MAIN-world bridge**

Capture only successful X responses, correlate request metadata to response, and forward the normalized action. Keep the existing fallback capture behavior when response parsing fails.

**Step 3: Carry `resultTweetId` through storage, report, ticket proof and backend DTOs**

Make it optional for compatibility. It cannot itself mark an action verified.

**Step 4: Verify and commit**

```bash
git commit -m "feat(extension): capture created comment tweet ids"
git commit -m "feat(plugin-verify): accept comment result tweet evidence"
```

## Task 6: Make server-side Twitter verification authoritative

**Backend files:**

- Create: `backend/src/modules/plugin-verify/comment-evidence-verifier.service.ts`
- Create: `backend/src/modules/plugin-verify/comment-evidence-verifier.service.spec.ts`
- Modify: `backend/src/modules/plugin-verify/plugin-verify.service.ts`
- Modify: `backend/src/modules/twitter-verify/twitter-verify.service.ts`
- Modify: `backend/src/modules/twitter-verify/twitter-verify.service.spec.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign-engage.service.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign-engage-reserved.spec.ts`

**Step 1: Write failing verification tests**

For comments, verify the reply:

- exists and is not deleted;
- is authored by the user’s bound X account;
- directly replies to the campaign target tweet;
- satisfies configured keyword/content rules;
- was created after `reservedAt` and before the deadline;
- has not already verified another task.

For LIKE/RT/FOLLOW, require the existing Twitter verification service before reward. Twitter transient/data-lag results stay in verifying/retry state, not fail-open and not immediate fail.

**Step 2: Implement the verifier and remove plugin-authoritative shortcuts**

Client `PASS`, signed capture, HMAC, dwell and watermark are audit signals only. Remove the default plugin-authoritative FOLLOW behavior and any comment path where signed `PASS` bypasses Twitter verification.

**Step 3: Preserve current user-visible state transitions**

Successful normal flows still move through the existing `verifySubmittedAt`, review/cooldown and reward pipeline. Do not change reward calculation or UI response types.

**Step 4: Verify and commit**

```bash
git commit -m "fix(plugin-verify): require server-side action verification"
```

## Task 7: Add comment URL evidence fallback

**Backend files:**

- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_add_comment_evidence/migration.sql`
- Create: `backend/src/modules/plugin-verify/dto/submit-comment-evidence.input.ts`
- Create: `backend/src/modules/plugin-verify/comment-evidence.service.ts`
- Create: `backend/src/modules/plugin-verify/comment-evidence.service.spec.ts`
- Modify: `backend/src/modules/plugin-verify/plugin-verify.resolver.ts`
- Modify: `backend/src/modules/plugin-verify/plugin-verify.module.ts`

**Frontend files:**

- Modify: `frontend/src/app/(main)/campaigns/query.ts`
- Create: `frontend/src/app/(main)/campaigns/_components/task-detail/comment-evidence-form.tsx`
- Create: `frontend/src/app/(main)/campaigns/_components/task-detail/comment-evidence-form.spec.tsx`
- Modify: `frontend/src/app/(main)/campaigns/_components/task-detail-content.tsx`
- Modify: `frontend/src/app/(main)/campaigns/_components/task-detail/task-detail-hero.tsx`

**Step 1: Add failing URL and anti-reuse tests**

Accept only `https://x.com/<handle>/status/<tweetId>` and `https://twitter.com/<handle>/status/<tweetId>`. Normalize host/path and use only tweet ID for authorization. Reject other schemes, hosts, routes, query tricks and nonnumeric IDs.

**Step 2: Add evidence persistence**

Create `EngagementCommentEvidence` with campaign, participant, user, tweet ID, source (`PLUGIN_CAPTURE`/`USER_URL`), status (`PENDING`/`VERIFIED`/`REJECTED`), reason and timestamps. Add a partial unique index on `tweetId` only where status is `VERIFIED`; rejected evidence must not lock the tweet forever.

**Step 3: Add Cookie/JWT-only mutation**

```graphql
mutation SubmitEngagementCommentEvidence($campaignId: String!, $commentUrl: String!)
```

Do not add `@AllowPluginToken()`. Reuse Task 6’s exact verifier and return the existing verification status shape.

**Step 4: Show the form only after abnormal capture failure**

When a reserved task contains COMMENT/COMMENT_LIKE and the plugin reports missing COMMENT or times out, replace the dead-end toast with a compact URL form. Normal captured flows render no new field and continue automatically.

**Step 5: Verify and commit**

```bash
git commit -m "feat(plugin-verify): accept verified comment URL evidence"
git commit -m "feat(task-detail): add comment evidence fallback"
```

## Task 8: Add durable idempotency to spend operations

**Backend files:**

- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_add_plugin_idempotency/migration.sql`
- Create: `backend/src/modules/plugin-security/plugin-idempotency.service.ts`
- Create: `backend/src/modules/plugin-security/plugin-idempotency.service.spec.ts`
- Modify: `backend/src/modules/unified-campaign/unified-campaign.resolver.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign.service.ts`
- Modify: `backend/src/modules/auto-reinvest/auto-reinvest.resolver.ts`
- Modify: `backend/src/modules/auto-reinvest/auto-reinvest.service.ts`

**Extension files:**

- Modify: `lhdao-extension/src/lib/gql.ts`
- Modify: `lhdao-extension/src/entrypoints/background.ts`
- Create: `lhdao-extension/src/lib/__tests__/idempotency.test.ts`

**Step 1: Write failing concurrency/crash tests**

Cover same key + same variables returns original result, same key + different variables returns `PLUGIN_IDEMPOTENCY_CONFLICT`, concurrent duplicate creates only one business object/debit, and records expire after 24 hours.

**Step 2: Add durable idempotency records**

Unique key: `(userId, operationId, idempotencyKey)`. Store `variablesSha256`, status, serialized response, created/expiry timestamps. The idempotency row and campaign/task creation plus debit must commit in the same PostgreSQL transaction.

**Step 3: Refactor services to accept a Prisma transaction client**

Do the smallest refactor necessary so `PromoteTweet` and `CreateAutoReinvestTask` can execute under the idempotency transaction. Preserve all existing validations, fee calculations, post-commit notifications and monitoring behavior.

**Step 4: Add extension keys**

Send `x-idempotency-key` for both spend operations. A retry of the same user action reuses the key; a new button action generates a new key. Auto-reinvest creation for each returned campaign gets its own stable child key.

**Step 5: Verify and commit**

```bash
git commit -m "feat(plugin-security): make spend operations idempotent"
git commit -m "feat(extension): attach spend idempotency keys"
```

## Task 9: Rollout telemetry and emergency controls

**Backend files:**

- Create: `backend/src/modules/plugin-security/plugin-security-audit.service.ts`
- Create: `backend/src/modules/plugin-security/plugin-security-audit.service.spec.ts`
- Modify: `backend/src/modules/plugin-security/plugin-request-security.service.ts`
- Modify: `backend/src/modules/plugin-security/plugin-security.guard.ts`
- Modify: `backend/.env.example`

**Extension files:**

- Modify: `lhdao-extension/src/lib/gql.ts`
- Modify: `lhdao-extension/src/entrypoints/background.ts`

**Step 1: Add structured audit events**

Record operation ID, permission, mode, token/device IDs, decision, stable error code, latency and hashed IP/user agent metadata. Never log bearer tokens, private/public key bodies, full variables, comment text or URLs.

**Step 2: Add rollout counters**

Track unsigned legacy share, signature failures, replay blocks, per-operation throttles, evidence outcomes and idempotency hits/conflicts.

**Step 3: Exercise modes**

- Audit: legacy requests accepted and counted.
- Enforce: unsigned/unknown operations rejected.
- Emergency read-only: public/read work; capture/verify/spend return a stable maintenance error.

**Step 4: Remove the temporary registration bridge before final enforce**

Only switch production to enforce after legacy unsigned share reaches zero and the current extension version adoption threshold is met.

**Step 5: Commit**

```bash
git commit -m "feat(plugin-security): add rollout modes and audit telemetry"
```

## Task 10: Full verification and integration

**Step 1: Backend verification**

Run:

```bash
pnpm test -- --runInBand plugin-security
pnpm test -- --runInBand plugin-verify
pnpm test -- --runInBand twitter-verify
pnpm run type-check
pnpm run build
```

Expected: zero failures and Prisma generation succeeds.

**Step 2: Frontend verification**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run build
```

Expected: zero failures; normal task detail UI is unchanged unless the missing-comment fallback is activated.

**Step 3: Extension verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
NEXT_PUBLIC_GRAPHQL_ENDPOINT=https://service.lhdaobeta.top/graphql pnpm build
```

Expected: zero failures and a test-environment extension artifact is produced.

**Step 4: Security regression matrix**

Manually verify:

1. Tampered query/alias/variables/signature are rejected.
2. Replayed nonce is rejected.
3. Copied token without the device private key is rejected.
4. Normal like/RT/comment/follow capture still auto-submits.
5. Comment result ID is server verified before review/reward.
6. Fully uncaptured comment can submit a valid URL; wrong author/parent/reused URL is rejected.
7. Retried promote/reinvest creates one debit and one logical result.
8. Cookie/JWT web operations and all non-plugin GraphQL operations are unchanged.
9. Emergency read-only keeps task browsing available and blocks all plugin writes.

**Step 5: Rebase/cherry-pick policy**

Rebase each isolated branch onto the latest `origin/dev`, resolve only task-owned conflicts, rerun the complete matrix, then merge to `dev`. Cherry-pick the resulting reviewed commits to `main` only after staging audit mode is healthy. Never merge the original dirty working directories wholesale.

