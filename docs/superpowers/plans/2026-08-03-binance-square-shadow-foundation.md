# Binance Square Shadow Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the platform-aware campaign fields and a beta-only, privacy-preserving Binance Square network probe that produces sanitized fixtures without entering any reward path.

**Architecture:** The backend remains the source of active and reserved campaign targets. The extension keeps the existing X capture path unchanged and adds separate Binance Square task indexes plus a dedicated MAIN/ISOLATED probe pair. The probe runs only in beta builds, only for reserved Binance targets, stores only sanitized shapes in extension session storage, and never submits engagement proof or requests a reward.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL, GraphQL, WXT MV3, TypeScript, Vitest, Jest, Biome.

---

## Scope boundary

This is the first executable milestone from the approved Binance Square design. It deliberately does **not** implement account binding, four authoritative action parsers, signed Binance proof, revocation, cooldown settlement, or reward enforcement. Those depend on real request/response fixtures that do not exist yet. The completion artifact of this plan is a set of sanitized beta fixtures for LIKE, COMMENT, SHARE, and FOLLOW; the next implementation plan must be written from those fixtures.

Do not add a production `SHARE` price in this milestone. The existing pricing
service safely returns zero for an absent action row, which is correct for a
non-paying shadow campaign. Commercial pricing is a separate product decision
for the enforcement milestone.

The work spans the backend and extension because a probe must be limited to real reserved Binance tasks. Frontend buyer UI is not changed in this milestone; internal beta campaigns are created through the existing GraphQL mutation.

## Protected working copies

The current `backend/` and `frontend/` directories contain user changes, and the frontend has unresolved conflicts. Do not edit either working copy directly. At execution time, use `using-git-worktrees` to create an isolated backend worktree from the latest `dev`. Continue extension work in the existing isolated worktree:

```text
Backend:   /Users/kkruis/Desktop/project/backend/.worktrees/binance-square-shadow-20260803
Extension: /Users/kkruis/Desktop/project/lhdao-extension/.worktrees/plan-a-advisory-validation-20260801
```

## File map

Backend files:

- Modify `backend/prisma/schema.prisma`: add platform enum, `SHARE`, and generic campaign target fields.
- Create `backend/prisma/migrations/20260803090000_add_engagement_platform/migration.sql`: additive schema migration.
- Create `backend/src/modules/unified-campaign/util/binance-square-target.util.ts`: strict Binance Square URL parsing.
- Create `backend/src/modules/unified-campaign/util/binance-square-target.util.spec.ts`: URL parser tests.
- Create `backend/src/modules/unified-campaign/util/binance-square-shadow-access.ts`: internal beta allowlist.
- Create `backend/src/modules/unified-campaign/util/binance-square-shadow-access.spec.ts`: allowlist tests.
- Modify `backend/src/modules/unified-campaign/dto/create-campaign.input.ts`: expose platform and generic targets.
- Modify `backend/src/modules/unified-campaign/dto/campaign.model.ts`: return platform and generic targets.
- Modify `backend/src/modules/unified-campaign/service/campaign.service.ts`: platform-specific creation validation and X side-effect isolation.
- Modify `backend/src/modules/unified-campaign/service/campaign.service.spec.ts`: creation regression tests.
- Modify `backend/src/modules/unified-campaign/service/campaign-engage.service.ts`: hide shadow tasks and reject verify.
- Create `backend/src/modules/unified-campaign/service/campaign-engage-binance-shadow.spec.ts`: verify-path hard-stop test.
- Modify `backend/src/modules/plugin-verify/plugin-verify.service.ts`: reject Binance ticket mint and proof submit.
- Modify `backend/src/modules/plugin-verify/plugin-verify.spec.ts`: ticket-path hard-stop tests.

Extension files:

- Modify `lhdao-extension/wxt.config.ts`: add the minimum Binance host permission.
- Modify `lhdao-extension/src/lib/queries.ts`: request platform and generic target fields.
- Modify `lhdao-extension/src/lib/storage.ts`: add Binance task and probe session types.
- Create `lhdao-extension/src/lib/binance-square-tasks.ts`: pure task indexing and reserved-target projection.
- Create `lhdao-extension/src/lib/__tests__/binance-square-tasks.test.ts`: task indexing tests.
- Create `lhdao-extension/src/lib/binance-square-probe.ts`: pure matching and sanitization logic.
- Create `lhdao-extension/src/lib/__tests__/binance-square-probe.test.ts`: privacy and bounds tests.
- Create `lhdao-extension/src/entrypoints/binance-square-probe.content.ts`: beta-only MAIN-world fetch/XHR observation.
- Create `lhdao-extension/src/entrypoints/binance-square-bridge.content.ts`: ISOLATED validation and forwarding.
- Modify `lhdao-extension/src/types/messages.ts`: Binance probe RPC contracts.
- Modify `lhdao-extension/src/lib/messaging.ts`: broadcast task updates to Binance Square tabs.
- Modify `lhdao-extension/src/entrypoints/background.ts`: sync Binance indexes and keep bounded observations.
- Modify `lhdao-extension/src/entrypoints/options/App.tsx`: beta-only fixture export panel.
- Modify `lhdao-extension/src/entrypoints/popup/App.test.tsx` only if shared rendering helpers require a regression adjustment; otherwise leave it untouched.

### Task 1: Add a strict Binance Square target parser

**Files:**

- Create: `backend/src/modules/unified-campaign/util/binance-square-target.util.ts`
- Create: `backend/src/modules/unified-campaign/util/binance-square-target.util.spec.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
import { parseBinanceSquareTarget } from './binance-square-target.util'

describe('parseBinanceSquareTarget', () => {
  it.each([
    'https://www.binance.com/en/square/post/335389698745313',
    'https://www.binance.com/zh-CN/square/post/335389698745313?ref=feed',
    'https://www.binance.com/square/post/335389698745313',
  ])('accepts a Square post URL: %s', raw => {
    expect(parseBinanceSquareTarget(raw)).toEqual({
      kind: 'CONTENT',
      targetContentId: '335389698745313',
      canonicalUrl:
        'https://www.binance.com/en/square/post/335389698745313',
    })
  })

  it('recognizes a profile URL without pretending the slug is an author id', () => {
    expect(
      parseBinanceSquareTarget(
        'https://www.binance.com/en/square/profile/square-creator-a5d12f39cc6a',
      ),
    ).toEqual({
      kind: 'PROFILE',
      profileSlug: 'square-creator-a5d12f39cc6a',
      canonicalUrl:
        'https://www.binance.com/en/square/profile/square-creator-a5d12f39cc6a',
    })
  })

  it.each([
    'https://evil.example/en/square/post/335389698745313',
    'https://www.binance.com/en/square/post/not-a-number',
    'https://www.binance.com/en/trade/BTC_USDT',
    'javascript:alert(1)',
  ])('rejects an invalid target: %s', raw => {
    expect(parseBinanceSquareTarget(raw)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run:

```bash
cd /Users/kkruis/Desktop/project/backend/.worktrees/binance-square-shadow-20260803
pnpm test -- --runInBand src/modules/unified-campaign/util/binance-square-target.util.spec.ts
```

Expected: FAIL because `binance-square-target.util.ts` does not exist.

- [ ] **Step 3: Implement the parser with the native URL API**

```ts
export type BinanceSquareTarget =
  | {
      kind: 'CONTENT'
      targetContentId: string
      canonicalUrl: string
    }
  | {
      kind: 'PROFILE'
      profileSlug: string
      canonicalUrl: string
    }

const CONTENT_ID_RE = /^\d{6,32}$/u
const PROFILE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/u

export function parseBinanceSquareTarget(
  raw: string | null | undefined,
): BinanceSquareTarget | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.binance.com') {
    return null
  }

  const parts = url.pathname.split('/').filter(Boolean)
  const squareIndex = parts.indexOf('square')
  if (squareIndex < 0) return null
  const resource = parts[squareIndex + 1]
  const identifier = parts[squareIndex + 2]
  if (!identifier || parts.length !== squareIndex + 3) return null

  if (resource === 'post' && CONTENT_ID_RE.test(identifier)) {
    return {
      kind: 'CONTENT',
      targetContentId: identifier,
      canonicalUrl: `https://www.binance.com/en/square/post/${identifier}`,
    }
  }
  if (resource === 'profile' && PROFILE_SLUG_RE.test(identifier)) {
    return {
      kind: 'PROFILE',
      profileSlug: identifier,
      canonicalUrl: `https://www.binance.com/en/square/profile/${identifier}`,
    }
  }
  return null
}
```

- [ ] **Step 4: Run the focused test**

Run the Step 2 command again.

Expected: PASS, 4 test cases/groups.

- [ ] **Step 5: Commit the parser**

```bash
git add src/modules/unified-campaign/util/binance-square-target.util.ts \
  src/modules/unified-campaign/util/binance-square-target.util.spec.ts
git commit -m "feat: parse Binance Square targets"
```

### Task 2: Add additive platform and target columns

**Files:**

- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260803090000_add_engagement_platform/migration.sql`
- Modify generated files under `backend/src/generated/graphql/prisma-graphql/` by running Prisma generation; do not hand-edit them.

- [ ] **Step 1: Add the Prisma enum and campaign fields**

Add beside `ActionTypeV2`:

```prisma
enum EngagementPlatform {
  X
  BINANCE_SQUARE
}

enum ActionTypeV2 {
  RT
  LIKE
  COMMENT
  FOLLOW
  COMMENT_LIKE
  SHARE
}
```

Add after `taskTemplate` in `UnifiedCampaign`:

```prisma
  platform                    EngagementPlatform           @default(X)
```

Add after the legacy target fields:

```prisma
  targetContentId             String?                      @db.VarChar(128)
  targetAuthorId              String?                      @db.VarChar(128)
```

Add indexes near the existing `UnifiedCampaign` indexes:

```prisma
  @@index([platform, targetContentId])
  @@index([platform, targetAuthorId])
```

- [ ] **Step 2: Write the additive SQL migration**

```sql
CREATE TYPE "EngagementPlatform" AS ENUM ('X', 'BINANCE_SQUARE');

ALTER TYPE "ActionTypeV2" ADD VALUE IF NOT EXISTS 'SHARE';

ALTER TABLE "unified_campaigns"
  ADD COLUMN "platform" "EngagementPlatform" NOT NULL DEFAULT 'X',
  ADD COLUMN "targetContentId" VARCHAR(128),
  ADD COLUMN "targetAuthorId" VARCHAR(128);

CREATE INDEX "unified_campaigns_platform_targetContentId_idx"
  ON "unified_campaigns"("platform", "targetContentId");

CREATE INDEX "unified_campaigns_platform_targetAuthorId_idx"
  ON "unified_campaigns"("platform", "targetAuthorId");
```

The existing `UnifiedCampaign` model is mapped to `unified_campaigns`; keep that
table identifier unchanged.

- [ ] **Step 3: Validate and regenerate**

Run:

```bash
pnpm exec prisma format
pnpm exec prisma validate
pnpm exec prisma generate
```

Expected: all three commands exit 0; generated GraphQL enums include `EngagementPlatform` and `SHARE`.

- [ ] **Step 4: Commit the schema milestone**

```bash
git add prisma/schema.prisma \
  prisma/migrations/20260803090000_add_engagement_platform \
  src/generated/graphql/prisma-graphql
git commit -m "feat: add engagement platform fields"
```

### Task 3: Validate Binance campaigns without touching X behavior

**Files:**

- Modify: `backend/src/modules/unified-campaign/dto/create-campaign.input.ts`
- Modify: `backend/src/modules/unified-campaign/dto/campaign.model.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign.service.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign.service.spec.ts`

- [ ] **Step 1: Add failing creation tests**

Add a focused `describe` block using the existing `createCampaignInTx` test rig:

```ts
describe('UnifiedCampaignService.createCampaignInTx — Binance Square shadow', () => {
  const buildBinanceInput = (overrides: Record<string, unknown> = {}) =>
    ({
      type: 'ENGAGEMENT',
      platform: 'BINANCE_SQUARE',
      targetUrl:
        'https://www.binance.com/en/square/post/335389698745313',
      totalBudget: 2,
      seats: 2,
      tierSeats: { E: 2 },
      targetTiers: ['E'],
      mode: 'OPEN',
      actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 2 }],
      ...overrides,
    }) as any

  const createBinance = async (overrides: Record<string, unknown> = {}) => {
    await (service as any).prisma.$transaction(async (tx: any) =>
      service.createCampaignInTx(
        buildBinanceInput(overrides),
        BUYER_ID,
        tx,
      ),
    )
    return callLog.find(c => c.name === 'unifiedCampaign.create')?.args
  }

  it('stores a Binance post as a generic content target', async () => {
    const data = await createBinance({
      targetUrl:
        'https://www.binance.com/en/square/post/335389698745313?ref=feed',
      actions: [
        { actionType: 'LIKE', baseReward: 1, targetCount: 2 },
        { actionType: 'SHARE', baseReward: 1, targetCount: 2 },
      ],
    })
    expect(data).toEqual(
      expect.objectContaining({
        platform: 'BINANCE_SQUARE',
        targetUrl:
          'https://www.binance.com/en/square/post/335389698745313',
        targetContentId: '335389698745313',
        targetAuthorId: null,
        tweetId: null,
        targetUsername: null,
      }),
    )
  })

  it.each(['RT', 'COMMENT_LIKE'])('rejects X-only action %s', async actionType => {
    await expect(
      createBinance({
        actions: [{ actionType, baseReward: 1, targetCount: 2 }],
      }),
    ).rejects.toThrow('BINANCE_ACTION_UNSUPPORTED')
  })

  it('fails closed for FOLLOW when the beta discovery gate is off', async () => {
    await expect(
      createBinance({
        targetUrl:
          'https://www.binance.com/en/square/profile/square-creator-a5d12f39cc6a',
        targetAuthorId: '123456789',
        actions: [{ actionType: 'FOLLOW', baseReward: 1, targetCount: 2 }],
      }),
    ).rejects.toThrow('BINANCE_FOLLOW_DISCOVERY_PENDING')
  })

  it('allows a numeric FOLLOW target only behind the beta discovery gate', async () => {
    const previous = process.env.BINANCE_SQUARE_FOLLOW_PROBE_ENABLED
    process.env.BINANCE_SQUARE_FOLLOW_PROBE_ENABLED = 'true'
    try {
      const data = await createBinance({
        targetUrl:
          'https://www.binance.com/en/square/profile/square-creator-a5d12f39cc6a',
        targetAuthorId: '123456789',
        actions: [{ actionType: 'FOLLOW', baseReward: 1, targetCount: 2 }],
      })
      expect(data).toEqual(
        expect.objectContaining({
          platform: 'BINANCE_SQUARE',
          targetContentId: null,
          targetAuthorId: '123456789',
          tweetId: null,
          targetUsername: null,
        }),
      )
    } finally {
      if (previous === undefined) {
        delete process.env.BINANCE_SQUARE_FOLLOW_PROBE_ENABLED
      } else {
        process.env.BINANCE_SQUARE_FOLLOW_PROBE_ENABLED = previous
      }
    }
  })

  it('keeps legacy X input on platform X', async () => {
    await (service as any).prisma.$transaction(async (tx: any) =>
      service.createCampaignInTx(
        { ...buildInput(), targetUrl: 'https://x.com/alice/status/123456' },
        BUYER_ID,
        tx,
      ),
    )
    const data = callLog.find(
      c => c.name === 'unifiedCampaign.create',
    )?.args
    expect(data).toEqual(
      expect.objectContaining({
        platform: 'X',
        tweetId: '123456',
      }),
    )
  })
})
```

Add `findMany: jest.fn(async () => [])` to the existing
`txMock.unifiedCampaign` delegate so both platform duplicate guards have a
deterministic empty result.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
pnpm test -- --runInBand src/modules/unified-campaign/service/campaign.service.spec.ts
```

Expected: FAIL because input/model/service do not know the new platform.

- [ ] **Step 3: Expose the new GraphQL fields**

In `create-campaign.input.ts`, import the generated `EngagementPlatform` and add:

```ts
  @Field(() => EngagementPlatform, {
    nullable: true,
    defaultValue: EngagementPlatform.X,
  })
  platform?: EngagementPlatform

  @Field({ nullable: true })
  targetContentId?: string

  @Field({ nullable: true })
  targetAuthorId?: string
```

In `campaign.model.ts`, import `EngagementPlatform` and add beside the target fields:

```ts
  @Field(() => EngagementPlatform)
  platform: EngagementPlatform

  @Field({ nullable: true })
  targetContentId?: string

  @Field({ nullable: true })
  targetAuthorId?: string
```

- [ ] **Step 4: Add the minimum platform branch to campaign creation**

Import `EngagementPlatform` from `@prisma/client` and `parseBinanceSquareTarget` from the new util. At the start of `createCampaign`, guard the Twitter comment-policy call:

```ts
    const platform = input.platform ?? EngagementPlatform.X
    if (platform === EngagementPlatform.X) {
      await this.assertReplyPolicyAllowsComments(
        input.targetUrl,
        input.type === CampaignTypeV2.ENGAGEMENT &&
          (input.actions?.some(
            a =>
              a.actionType === ActionTypeV2.COMMENT ||
              a.actionType === ActionTypeV2.COMMENT_LIKE,
          ) ?? false),
      )
    }
```

Replace the target parsing block inside `createCampaignInTx` with this platform split, leaving the existing X follow normalization immediately after the X branch:

```ts
    const platform = input.platform ?? EngagementPlatform.X
    let tweetId: string | undefined
    let targetUsername: string | undefined
    let targetContentId: string | undefined
    let targetAuthorId: string | undefined
    let resolvedTargetUrl: string | null = targetUrl ?? null

    if (platform === EngagementPlatform.BINANCE_SQUARE) {
      ThrowUtil.throwIf(
        type !== CampaignTypeV2.ENGAGEMENT,
        'BINANCE_PLATFORM_REQUIRES_ENGAGEMENT',
      )
      const parsed = parseBinanceSquareTarget(targetUrl)
      ThrowUtil.throwIf(!parsed, 'BINANCE_TARGET_INVALID')
      const actionTypes = (actions ?? []).map(a => String(a.actionType))
      ThrowUtil.throwIf(
        actionTypes.some(a => a === 'RT' || a === 'COMMENT_LIKE'),
        'BINANCE_ACTION_UNSUPPORTED',
      )
      const isFollowOnly =
        actionTypes.length > 0 && actionTypes.every(a => a === 'FOLLOW')
      if (isFollowOnly) {
        ThrowUtil.throwIf(
          process.env.BINANCE_SQUARE_FOLLOW_PROBE_ENABLED !== 'true',
          'BINANCE_FOLLOW_DISCOVERY_PENDING',
        )
        ThrowUtil.throwIf(
          parsed!.kind !== 'PROFILE',
          'BINANCE_PROFILE_REQUIRED',
        )
        const suppliedAuthorId = input.targetAuthorId?.trim() ?? ''
        ThrowUtil.throwIf(
          !/^\d{6,32}$/u.test(suppliedAuthorId),
          'BINANCE_AUTHOR_ID_INVALID',
        )
        targetAuthorId = suppliedAuthorId
      } else {
        ThrowUtil.throwIf(
          actionTypes.includes('FOLLOW'),
          'BINANCE_MIXED_FOLLOW_UNSUPPORTED',
        )
        ThrowUtil.throwIf(
          parsed!.kind !== 'CONTENT',
          'BINANCE_CONTENT_REQUIRED',
        )
        targetContentId = parsed!.targetContentId
      }
      resolvedTargetUrl = parsed!.canonicalUrl
    } else if (targetUrl) {
      const parsed = parseTwitterUrl(targetUrl)
      if (parsed) {
        tweetId = parsed.tweetId
        targetUsername = parsed.username
      }
      if (input.targetUsername) targetUsername = input.targetUsername
    }
```

Also add `platform === EngagementPlatform.X &&` to the existing
`isFollowOnlyCampaign` condition. This keeps the Twitter handle normalizer out
of the Binance branch even when the beta FOLLOW gate is enabled.

Add to the Prisma create data:

```ts
        platform,
        targetContentId: targetContentId ?? null,
        targetAuthorId: targetAuthorId ?? null,
```

Change the post-commit X analytics condition from an ENGAGEMENT-only check to:

```ts
    if (
      campaign.type === CampaignTypeV2.ENGAGEMENT &&
      campaign.platform === EngagementPlatform.X
    ) {
```

Add a Binance duplicate query before charging the buyer:

```ts
    if (
      platform === EngagementPlatform.BINANCE_SQUARE &&
      targetContentId &&
      actions?.length
    ) {
      const duplicates = await (tx as any).unifiedCampaign.findMany({
        where: {
          creatorId,
          platform,
          targetContentId,
          type: CampaignTypeV2.ENGAGEMENT,
          actions: {
            some: {
              actionType: {
                in: actions.map(a => a.actionType) as ActionTypeV2[],
              },
            },
          },
        },
        select: { id: true },
      })
      if (duplicates.length > 0) {
        throw new BadRequestException(
          JSON.stringify({
            code: 'DUPLICATE_CAMPAIGN',
            message: '该 Binance Square 内容已存在同类型任务',
            matchedCampaignIds: duplicates.map(d => d.id),
          }),
        )
      }
    }
```

- [ ] **Step 5: Run backend regression checks**

```bash
pnpm test -- --runInBand src/modules/unified-campaign/service/campaign.service.spec.ts
pnpm run type-check
```

Expected: focused Jest suite PASS; type-check exits 0.

- [ ] **Step 6: Commit campaign creation support**

```bash
git add src/modules/unified-campaign/dto/create-campaign.input.ts \
  src/modules/unified-campaign/dto/campaign.model.ts \
  src/modules/unified-campaign/service/campaign.service.ts \
  src/modules/unified-campaign/service/campaign.service.spec.ts
git commit -m "feat: create Binance Square shadow campaigns"
```

### Task 3B: Make the shadow campaign unreachable from reward paths

**Files:**

- Create: `backend/src/modules/unified-campaign/util/binance-square-shadow-access.ts`
- Create: `backend/src/modules/unified-campaign/util/binance-square-shadow-access.spec.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign.service.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign.service.spec.ts`
- Modify: `backend/src/modules/unified-campaign/service/campaign-engage.service.ts`
- Create: `backend/src/modules/unified-campaign/service/campaign-engage-binance-shadow.spec.ts`
- Modify: `backend/src/modules/plugin-verify/plugin-verify.service.ts`
- Modify: `backend/src/modules/plugin-verify/plugin-verify.spec.ts`

- [ ] **Step 1: Write the allowlist test**

```ts
import { isBinanceSquareShadowUser } from './binance-square-shadow-access'

describe('isBinanceSquareShadowUser', () => {
  it('fails closed when the allowlist is empty or malformed', () => {
    expect(isBinanceSquareShadowUser('u1', {} as NodeJS.ProcessEnv)).toBe(false)
    expect(
      isBinanceSquareShadowUser('u1', {
        BINANCE_SQUARE_SHADOW_USER_IDS: ' u2, ,u3 ',
      } as NodeJS.ProcessEnv),
    ).toBe(false)
  })

  it('matches an exact internal user id', () => {
    expect(
      isBinanceSquareShadowUser('u1', {
        BINANCE_SQUARE_SHADOW_USER_IDS: 'u1,u2',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

```bash
pnpm test -- --runInBand src/modules/unified-campaign/util/binance-square-shadow-access.spec.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the exact allowlist helper**

```ts
export function isBinanceSquareShadowUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!userId) return false
  return new Set(
    (env.BINANCE_SQUARE_SHADOW_USER_IDS ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  ).has(userId)
}
```

- [ ] **Step 4: Gate creation and task visibility**

In `UnifiedCampaignService.createCampaign`, immediately after resolving the
platform, reject non-internal creators:

```ts
    if (
      platform === EngagementPlatform.BINANCE_SQUARE &&
      !isBinanceSquareShadowUser(creatorId)
    ) {
      throw new ForbiddenException('BINANCE_SQUARE_SHADOW_ONLY')
    }
```

Import `ForbiddenException` and the helper. In the Binance test block, save and
restore `BINANCE_SQUARE_SHADOW_USER_IDS` in `beforeAll`/`afterAll`, setting it
to `BUYER_ID` during the tests. Add one test with the variable cleared that
expects `BINANCE_SQUARE_SHADOW_ONLY`.

In `_computeAvailableEngagements`, add this as the first campaign filter:

```ts
      if (
        c.platform === 'BINANCE_SQUARE' &&
        !isBinanceSquareShadowUser(userId)
      ) {
        return false
      }
```

In `listReservedEngagements`, add the platform restriction to the campaign
query for non-internal users:

```ts
        ...(isBinanceSquareShadowUser(userId)
          ? {}
          : { platform: EngagementPlatform.X }),
```

In `reserveSlot`, include `platform: true` in the campaign select and add after
the ENGAGEMENT type check:

```ts
    ThrowUtil.throwIf(
      campaign.platform === EngagementPlatform.BINANCE_SQUARE &&
        !isBinanceSquareShadowUser(userId),
      'BINANCE_SQUARE_SHADOW_ONLY',
    )
```

This permits allowlisted beta users to reserve a probe target but prevents a
direct mutation from bypassing task-hall visibility.

- [ ] **Step 5: Add an early verify-path test**

```ts
import { CampaignEngageService } from './campaign-engage.service'

describe('CampaignEngageService Binance Square shadow guard', () => {
  it('rejects before participant, OAuth, queue, or Twitter work', async () => {
    const service = Object.create(CampaignEngageService.prototype) as any
    service.assertPerUserRateLimit = jest.fn(async () => undefined)
    service.prisma = {
      unifiedCampaign: {
        findUnique: jest.fn(async () => ({
          id: 'c-binance',
          type: 'ENGAGEMENT',
          status: 'ACTIVE',
          platform: 'BINANCE_SQUARE',
          actions: [{ actionType: 'LIKE' }],
        })),
      },
      unifiedCampaignParticipant: { findUnique: jest.fn() },
      oAuthAccount: { findFirst: jest.fn() },
    }
    service.queue = { add: jest.fn() }

    await expect(
      service.requestVerify('c-binance', 'u1', { source: 'plugin' }),
    ).rejects.toThrow('BINANCE_SQUARE_SHADOW_ONLY')
    expect(service.prisma.unifiedCampaignParticipant.findUnique).not.toHaveBeenCalled()
    expect(service.prisma.oAuthAccount.findFirst).not.toHaveBeenCalled()
    expect(service.queue.add).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Add hard stops at every verify boundary**

In the initial campaign select of `requestVerify`, include `platform: true`,
then add immediately after the ENGAGEMENT type/status checks:

```ts
    ThrowUtil.throwIf(
      campaign.platform === EngagementPlatform.BINANCE_SQUARE,
      'BINANCE_SQUARE_SHADOW_ONLY',
    )
```

In `verifyAndRewardInner`, add the same guard immediately after loading and
checking the campaign. This protects jobs inserted outside `requestVerify`.

In both campaign selects in `PluginVerifyService` include `platform: true` and
add before minting or peeking a ticket:

```ts
    if (campaign.platform === 'BINANCE_SQUARE') {
      throw new BadRequestException({
        code: 'BINANCE_SQUARE_SHADOW_ONLY',
        message: 'Binance Square beta 任务尚未开放验证与发奖',
      })
    }
```

Add one mint test and one submit test in `plugin-verify.spec.ts`; each returns a
Binance campaign from the existing Prisma mock and asserts watermark ticket
methods, `recordCapture`, and `requestVerify` are not called.

- [ ] **Step 7: Run the hard-stop regressions**

```bash
pnpm test -- --runInBand \
  src/modules/unified-campaign/util/binance-square-shadow-access.spec.ts \
  src/modules/unified-campaign/service/campaign-engage-binance-shadow.spec.ts \
  src/modules/plugin-verify/plugin-verify.spec.ts \
  src/modules/unified-campaign/service/campaign.service.spec.ts
pnpm run type-check
```

Expected: all suites PASS; no Binance path can mint a ticket, enqueue verify,
run Twitter verification, or settle a reward.

- [ ] **Step 8: Commit the shadow boundary**

```bash
git add src/modules/unified-campaign/util/binance-square-shadow-access.ts \
  src/modules/unified-campaign/util/binance-square-shadow-access.spec.ts \
  src/modules/unified-campaign/service/campaign.service.ts \
  src/modules/unified-campaign/service/campaign.service.spec.ts \
  src/modules/unified-campaign/service/campaign-engage.service.ts \
  src/modules/unified-campaign/service/campaign-engage-binance-shadow.spec.ts \
  src/modules/plugin-verify/plugin-verify.service.ts \
  src/modules/plugin-verify/plugin-verify.spec.ts
git commit -m "feat: isolate Binance Square shadow campaigns"
```

### Task 4: Index Binance tasks separately in the extension

**Files:**

- Modify: `lhdao-extension/src/lib/queries.ts`
- Modify: `lhdao-extension/src/lib/storage.ts`
- Create: `lhdao-extension/src/lib/binance-square-tasks.ts`
- Create: `lhdao-extension/src/lib/__tests__/binance-square-tasks.test.ts`
- Modify: `lhdao-extension/src/entrypoints/background.ts`

- [ ] **Step 1: Write failing task-index tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  indexBinanceSquareTasks,
  reservedBinanceProbeTargets,
} from '../binance-square-tasks'

const campaigns = [
  {
    id: 'c-like',
    type: 'ENGAGEMENT',
    platform: 'BINANCE_SQUARE',
    targetUrl: 'https://www.binance.com/en/square/post/335389698745313',
    targetContentId: '335389698745313',
    targetAuthorId: null,
    actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 1 }],
  },
  {
    id: 'c-x',
    type: 'ENGAGEMENT',
    platform: 'X',
    targetUrl: 'https://x.com/a/status/1',
    targetContentId: null,
    targetAuthorId: null,
    actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 1 }],
  },
] as any

describe('indexBinanceSquareTasks', () => {
  it('indexes only Binance targets and marks reserved campaigns', () => {
    expect(indexBinanceSquareTasks(campaigns, new Set(['c-like']))).toEqual({
      byContentId: {
        '335389698745313': [
          expect.objectContaining({
            campaignId: 'c-like',
            actionType: 'LIKE',
            reserved: true,
          }),
        ],
      },
      byAuthorId: {},
    })
  })

  it('projects only reserved targets into probe config', () => {
    const index = indexBinanceSquareTasks(campaigns, new Set(['c-like']))
    expect(reservedBinanceProbeTargets(index)).toEqual([
      { kind: 'CONTENT', id: '335389698745313' },
    ])
  })
})
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
cd /Users/kkruis/Desktop/project/lhdao-extension/.worktrees/plan-a-advisory-validation-20260801
pnpm test -- src/lib/__tests__/binance-square-tasks.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add GraphQL and storage contracts**

Request `platform`, `targetContentId`, and `targetAuthorId` in both engagement queries. Extend the action union with `SHARE`, and extend `AvailableEngagement`:

```ts
export type EngagementPlatform = 'X' | 'BINANCE_SQUARE'

export interface AvailableEngagement {
  // existing fields stay unchanged
  platform: EngagementPlatform
  targetContentId: string | null
  targetAuthorId: string | null
}
```

Add these storage types:

```ts
export type BinanceSquareActionType =
  | 'LIKE'
  | 'COMMENT'
  | 'SHARE'
  | 'FOLLOW'

export interface BinanceSquareTaskCache {
  campaignId: string
  actionType: BinanceSquareActionType
  targetUrl: string
  targetContentId?: string
  targetAuthorId?: string
  reserved: boolean
}

export interface BinanceSquareTaskIndex {
  byContentId: Record<string, BinanceSquareTaskCache[]>
  byAuthorId: Record<string, BinanceSquareTaskCache[]>
}
```

Add to `SessionSchema`:

```ts
  binanceSquareTasks: BinanceSquareTaskIndex
  binanceSquareProbeObservations: BinanceProbeObservation[]
```

Import `BinanceProbeObservation` from the probe module with `import type` to avoid a runtime cycle.

- [ ] **Step 4: Implement pure task indexing**

```ts
import type { AvailableEngagement } from './queries'
import type {
  BinanceSquareActionType,
  BinanceSquareTaskCache,
  BinanceSquareTaskIndex,
} from './storage'

const ACTIONS = new Set<BinanceSquareActionType>([
  'LIKE',
  'COMMENT',
  'SHARE',
  'FOLLOW',
])

export function indexBinanceSquareTasks(
  campaigns: AvailableEngagement[],
  reservedIds: Set<string>,
): BinanceSquareTaskIndex {
  const out: BinanceSquareTaskIndex = { byContentId: {}, byAuthorId: {} }
  for (const campaign of campaigns) {
    if (
      campaign.type !== 'ENGAGEMENT' ||
      campaign.platform !== 'BINANCE_SQUARE' ||
      !campaign.targetUrl
    ) {
      continue
    }
    for (const action of campaign.actions) {
      if (!ACTIONS.has(action.actionType as BinanceSquareActionType)) continue
      const row: BinanceSquareTaskCache = {
        campaignId: campaign.id,
        actionType: action.actionType as BinanceSquareActionType,
        targetUrl: campaign.targetUrl,
        ...(campaign.targetContentId
          ? { targetContentId: campaign.targetContentId }
          : {}),
        ...(campaign.targetAuthorId
          ? { targetAuthorId: campaign.targetAuthorId }
          : {}),
        reserved: reservedIds.has(campaign.id),
      }
      if (row.targetContentId) {
        ;(out.byContentId[row.targetContentId] ??= []).push(row)
      }
      if (row.targetAuthorId) {
        ;(out.byAuthorId[row.targetAuthorId] ??= []).push(row)
      }
    }
  }
  return out
}

export function reservedBinanceProbeTargets(index: BinanceSquareTaskIndex) {
  const targets: Array<{ kind: 'CONTENT' | 'AUTHOR'; id: string }> = []
  for (const [id, tasks] of Object.entries(index.byContentId)) {
    if (tasks.some(task => task.reserved)) {
      targets.push({ kind: 'CONTENT', id })
    }
  }
  for (const [id, tasks] of Object.entries(index.byAuthorId)) {
    if (tasks.some(task => task.reserved)) {
      targets.push({ kind: 'AUTHOR', id })
    }
  }
  return targets.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
}
```

- [ ] **Step 5: Wire the index into `performSyncTasks`**

After merging available and reserved engagements:

```ts
    const binanceIndex = indexBinanceSquareTasks(merged, reservedIds)
    await sessionStore.set('binanceSquareTasks', binanceIndex)
```

When there is no token, also clear the index:

```ts
    await sessionStore.set('binanceSquareTasks', {
      byContentId: {},
      byAuthorId: {},
    })
```

Do not alter `flattenTasks`; X indexes remain byte-for-byte compatible.

- [ ] **Step 6: Run extension tests and typecheck**

```bash
pnpm test -- src/lib/__tests__/binance-square-tasks.test.ts \
  src/lib/__tests__/engagement-capture.test.ts
pnpm typecheck
```

Expected: both test files PASS; typecheck exits 0.

- [ ] **Step 7: Commit the task index**

```bash
git add src/lib/queries.ts src/lib/storage.ts \
  src/lib/binance-square-tasks.ts \
  src/lib/__tests__/binance-square-tasks.test.ts \
  src/entrypoints/background.ts
git commit -m "feat: sync Binance Square shadow targets"
```

### Task 5: Build a bounded sanitizer before intercepting traffic

**Files:**

- Create: `lhdao-extension/src/lib/binance-square-probe.ts`
- Create: `lhdao-extension/src/lib/__tests__/binance-square-probe.test.ts`

- [ ] **Step 1: Write privacy and matching tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  buildProbeObservation,
  findProbeTarget,
  sanitizeProbeValue,
} from '../binance-square-probe'

const targets = [{ kind: 'CONTENT', id: '335389698745313' }] as const

describe('Binance Square probe sanitizer', () => {
  it('matches only a configured target in a bounded JSON body', () => {
    expect(
      findProbeTarget(
        { postId: '335389698745313', text: 'private comment' },
        targets,
      ),
    ).toEqual(targets[0])
    expect(findProbeTarget({ postId: '999' }, targets)).toBeNull()
  })

  it('replaces target ids and all user strings', () => {
    expect(
      sanitizeProbeValue(
        {
          postId: '335389698745313',
          text: 'private comment',
          ok: true,
          nested: { uid: '123456789' },
        },
        targets,
      ),
    ).toEqual({
      nested: { uid: '<digits:9>' },
      ok: true,
      postId: '<target:CONTENT>',
      text: '<string:15>',
    })
  })

  it('drops query strings, headers, cookies, and raw bodies', () => {
    const observation = buildProbeObservation({
      url: 'https://www.binance.com/bapi/example?token=secret',
      method: 'POST',
      status: 200,
      request: { postId: '335389698745313', text: 'private comment' },
      response: { code: '000000', data: { id: '987654321' } },
      targets,
      capturedAt: '2026-08-03T00:00:00.000Z',
    })
    expect(JSON.stringify(observation)).not.toContain('secret')
    expect(JSON.stringify(observation)).not.toContain('private comment')
    expect(observation?.path).toBe('/bapi/example')
  })

  it('bounds depth, object keys, arrays, and output size', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, { deep: { value: i } }]),
    )
    const out = sanitizeProbeValue(wide, targets)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(16_384)
  })
})
```

- [ ] **Step 2: Run the test and confirm failure**

```bash
pnpm test -- src/lib/__tests__/binance-square-probe.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure sanitizer**

Define these exported contracts and limits:

```ts
export type BinanceProbeTarget = {
  kind: 'CONTENT' | 'AUTHOR'
  id: string
}

export interface BinanceProbeObservation {
  id: string
  method: 'POST'
  path: string
  status: number
  target: BinanceProbeTarget
  requestShape: unknown
  responseShape: unknown
  capturedAt: string
}

const MAX_DEPTH = 6
const MAX_KEYS = 80
const MAX_ARRAY_ITEMS = 5
const MAX_JSON_LENGTH = 16_384
```

Complete the module with the following bounded implementation. It accepts no
headers or cookies, drops sensitive keys, strips query strings, and validates
that messages contain sanitizer markers rather than raw scalar values.

```ts
const MAX_NODES = 500
const SENSITIVE_KEY_RE =
  /authorization|cookie|csrf|secret|session|token|credential|password/i
const SAFE_MARKER_RE =
  /^<(?:target:(?:CONTENT|AUTHOR)|digits:\d+|string:\d+|number|max-depth|max-nodes|circular|unsupported)>$/u

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function targetForScalar(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
): BinanceProbeTarget | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const scalar = String(value)
  return targets.find(target => target.id === scalar) ?? null
}

export function findProbeTarget(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
): BinanceProbeTarget | null {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ]
  let visited = 0
  while (stack.length > 0 && visited < MAX_NODES) {
    const current = stack.pop()!
    visited += 1
    const matched = targetForScalar(current.value, targets)
    if (matched) return matched
    if (current.depth >= MAX_DEPTH || !current.value) continue
    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, MAX_ARRAY_ITEMS)) {
        stack.push({ value: item, depth: current.depth + 1 })
      }
      continue
    }
    const obj = record(current.value)
    if (!obj) continue
    for (const key of Object.keys(obj).sort().slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY_RE.test(key)) continue
      stack.push({ value: obj[key], depth: current.depth + 1 })
    }
  }
  return null
}

function sanitize(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
): unknown {
  state.nodes += 1
  if (state.nodes > MAX_NODES) return '<max-nodes>'
  if (depth > MAX_DEPTH) return '<max-depth>'
  if (value === null || typeof value === 'boolean') return value
  const matched = targetForScalar(value, targets)
  if (matched) return `<target:${matched.kind}>`
  if (typeof value === 'string') {
    return /^\d+$/u.test(value)
      ? `<digits:${value.length}>`
      : `<string:${value.length}>`
  }
  if (typeof value === 'number') return '<number>'
  if (!value || typeof value !== 'object') return '<unsupported>'
  if (state.seen.has(value)) return '<circular>'
  state.seen.add(value)
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => sanitize(item, targets, depth + 1, state))
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort().slice(0, MAX_KEYS)) {
    if (SENSITIVE_KEY_RE.test(key)) continue
    out[key] = sanitize(
      (value as Record<string, unknown>)[key],
      targets,
      depth + 1,
      state,
    )
  }
  return out
}

export function sanitizeProbeValue(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
): unknown {
  const result = sanitize(value, targets, 0, {
    nodes: 0,
    seen: new WeakSet(),
  })
  return JSON.stringify(result).length <= MAX_JSON_LENGTH
    ? result
    : { truncated: true }
}

function probePath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.binance.com' ||
      !url.pathname.startsWith('/bapi/')
    ) {
      return null
    }
    return url.pathname
      .split('/')
      .map(part =>
        /^\d{6,}$/u.test(part) || /^[A-Za-z0-9_-]{24,}$/u.test(part)
          ? ':id'
          : part,
      )
      .join('/')
      .slice(0, 512)
  } catch {
    return null
  }
}

export function buildProbeObservation(args: {
  url: string
  method: string
  status: number
  request: unknown
  response: unknown
  targets: readonly BinanceProbeTarget[]
  capturedAt: string
}): BinanceProbeObservation | null {
  const path = probePath(args.url)
  const target = findProbeTarget(args.request, args.targets)
  if (
    args.method.toUpperCase() !== 'POST' ||
    !path ||
    !target ||
    !Number.isInteger(args.status) ||
    args.status < 0 ||
    args.status > 599
  ) {
    return null
  }
  return {
    id: crypto.randomUUID(),
    method: 'POST',
    path,
    status: args.status,
    target,
    requestShape: sanitizeProbeValue(args.request, args.targets),
    responseShape: sanitizeProbeValue(args.response, args.targets),
    capturedAt: args.capturedAt,
  }
}

function isSanitizedShape(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH + 1) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return SAFE_MARKER_RE.test(value)
  if (typeof value === 'number' || typeof value === 'undefined') return false
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_ARRAY_ITEMS &&
      value.every(item => isSanitizedShape(item, depth + 1))
    )
  }
  const obj = record(value)
  if (!obj || Object.keys(obj).length > MAX_KEYS) return false
  return Object.entries(obj).every(
    ([key, item]) =>
      key.length <= 128 &&
      !SENSITIVE_KEY_RE.test(key) &&
      isSanitizedShape(item, depth + 1),
  )
}

export function parseProbeObservation(
  value: unknown,
): BinanceProbeObservation | null {
  const obj = record(value)
  const target = record(obj?.target)
  if (
    !obj ||
    typeof obj.id !== 'string' ||
    obj.id.length > 128 ||
    obj.method !== 'POST' ||
    typeof obj.path !== 'string' ||
    !obj.path.startsWith('/bapi/') ||
    obj.path.length > 512 ||
    !Number.isInteger(obj.status) ||
    Number(obj.status) < 0 ||
    Number(obj.status) > 599 ||
    !target ||
    (target.kind !== 'CONTENT' && target.kind !== 'AUTHOR') ||
    typeof target.id !== 'string' ||
    !/^\d{6,32}$/u.test(target.id) ||
    typeof obj.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(obj.capturedAt)) ||
    !isSanitizedShape(obj.requestShape) ||
    !isSanitizedShape(obj.responseShape) ||
    JSON.stringify(obj.requestShape).length > MAX_JSON_LENGTH ||
    JSON.stringify(obj.responseShape).length > MAX_JSON_LENGTH
  ) {
    return null
  }
  return obj as unknown as BinanceProbeObservation
}

export function parseProbeObservationMessage(
  value: unknown,
): BinanceProbeObservation | null {
  const obj = record(value)
  return obj?.__lhBinanceProbe === true
    ? parseProbeObservation(obj.observation)
    : null
}
```

- [ ] **Step 4: Run the sanitizer tests**

Run the Step 2 command again.

Expected: PASS, including the negative privacy assertions.

- [ ] **Step 5: Commit the sanitizer**

```bash
git add src/lib/binance-square-probe.ts \
  src/lib/__tests__/binance-square-probe.test.ts
git commit -m "feat: sanitize Binance Square probe traffic"
```

### Task 6: Add the beta-only MAIN/ISOLATED probe pair

**Files:**

- Modify: `lhdao-extension/wxt.config.ts`
- Create: `lhdao-extension/src/entrypoints/binance-square-probe.content.ts`
- Create: `lhdao-extension/src/entrypoints/binance-square-bridge.content.ts`
- Modify: `lhdao-extension/src/types/messages.ts`
- Modify: `lhdao-extension/src/lib/messaging.ts`
- Modify: `lhdao-extension/src/entrypoints/background.ts`

- [ ] **Step 1: Add the minimum manifest scope**

Add only this host permission:

```ts
'https://www.binance.com/*'
```

Do not add cookies, webRequest, debugger, downloads, or broad `*://*/*` permissions.

- [ ] **Step 2: Add typed RPCs**

Add request variants:

```ts
  | { type: 'get-binance-probe-targets' }
  | {
      type: 'report-binance-probe-observation'
      observation: BinanceProbeObservation
    }
  | { type: 'export-binance-probe-observations' }
  | { type: 'clear-binance-probe-observations' }
```

Add response variants:

```ts
  | {
      type: 'binance-probe-targets'
      targets: BinanceProbeTarget[]
    }
  | {
      type: 'binance-probe-observations'
      observations: BinanceProbeObservation[]
    }
```

All imports from the probe module must be type-only.

- [ ] **Step 3: Implement the ISOLATED bridge**

Create a content script matching both locale and no-locale Square paths:

```ts
import { CAPTURE_DEBUG } from '@/lib/capture-debug'
import { sendMessage } from '@/lib/messaging'
import {
  parseProbeObservationMessage,
  type BinanceProbeTarget,
} from '@/lib/binance-square-probe'

export default defineContentScript({
  matches: [
    'https://www.binance.com/*/square/*',
    'https://www.binance.com/square/*',
  ],
  world: 'ISOLATED',
  runAt: 'document_start',
  main() {
    if (!CAPTURE_DEBUG) return
    let currentTargets: BinanceProbeTarget[] = []

    const publishTargets = async () => {
      const response = await sendMessage({ type: 'get-binance-probe-targets' })
      if (response.type !== 'binance-probe-targets') return
      currentTargets = response.targets
      window.postMessage(
        { __lhBinanceProbeConfig: true, targets: response.targets },
        window.location.origin,
      )
    }

    void publishTargets()
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'tasks-updated') void publishTargets()
    })
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return
      }
      const observation = parseProbeObservationMessage(event.data)
      if (!observation) return
      if (
        !currentTargets.some(
          target =>
            target.kind === observation.target.kind &&
            target.id === observation.target.id,
        )
      ) {
        return
      }
      void sendMessage({
        type: 'report-binance-probe-observation',
        observation,
      })
    })
  },
})
```

Implement `parseProbeObservationMessage` in `binance-square-probe.ts`. It must require the marker, `POST`, a `/bapi/` path of at most 512 characters, HTTP status 0–599, a configured target-shaped object, ISO `capturedAt`, and serialized shape size at most 16,384 characters.

- [ ] **Step 4: Implement the MAIN-world probe**

Create the dedicated MAIN-world file below. It reuses the proven body-reading
pattern but does not import or modify X capture code.

```ts
import { CAPTURE_DEBUG } from '@/lib/capture-debug'
import {
  buildProbeObservation,
  findProbeTarget,
  type BinanceProbeTarget,
} from '@/lib/binance-square-probe'

function urlOf(input: unknown): string | undefined {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : (input as Request)?.url
}

function isCandidate(url: string | undefined, method: string): boolean {
  if (!url || method.toUpperCase() !== 'POST') return false
  try {
    const parsed = new URL(url, window.location.href)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'www.binance.com' &&
      parsed.pathname.startsWith('/bapi/')
    )
  } catch {
    return false
  }
}

async function readBody(
  input: RequestInfo | URL | undefined,
  body: BodyInit | null | undefined,
): Promise<string | undefined> {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Blob) return body.text().catch(() => undefined)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body as ArrayBufferView)
  }
  if (input instanceof Request && input.body != null) {
    return input.clone().text().catch(() => undefined)
  }
  return undefined
}

function json(text: string | undefined): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export default defineContentScript({
  matches: [
    'https://www.binance.com/*/square/*',
    'https://www.binance.com/square/*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    if (!CAPTURE_DEBUG) return
    let targets: BinanceProbeTarget[] = []

    window.addEventListener('message', event => {
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        event.data?.__lhBinanceProbeConfig !== true ||
        !Array.isArray(event.data.targets)
      ) {
        return
      }
      targets = event.data.targets.filter(
        (target: unknown): target is BinanceProbeTarget =>
          !!target &&
          typeof target === 'object' &&
          ('kind' in target) &&
          (target.kind === 'CONTENT' || target.kind === 'AUTHOR') &&
          ('id' in target) &&
          typeof target.id === 'string' &&
          /^\d{6,32}$/u.test(target.id),
      )
    })

    const emit = (args: {
      url: string
      status: number
      request: unknown
      response: unknown
    }) => {
      const observation = buildProbeObservation({
        ...args,
        method: 'POST',
        targets,
        capturedAt: new Date().toISOString(),
      })
      if (!observation) return
      window.postMessage(
        { __lhBinanceProbe: true, observation },
        window.location.origin,
      )
    }

    const originalFetch = window.fetch
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const input = args[0]
      const init = args[1]
      const url = urlOf(input)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      const candidate = targets.length > 0 && isCandidate(url, method)
      const requestBody = candidate ? readBody(input, init?.body) : null
      const result = originalFetch.apply(this, args)
      if (candidate && url && requestBody) {
        void result
          .then(async response => {
            const request = json(await requestBody)
            if (!findProbeTarget(request, targets)) return
            const responseJson = await response
              .clone()
              .json()
              .catch(() => null)
            emit({ url, status: response.status, request, response: responseJson })
          })
          .catch(() => undefined)
      }
      return result
    }

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (...args: unknown[]) {
      const state = this as XMLHttpRequest & {
        __lhBinanceProbeUrl?: string
        __lhBinanceProbeMethod?: string
      }
      state.__lhBinanceProbeMethod = String(args[0] ?? 'GET')
      state.__lhBinanceProbeUrl = String(args[1] ?? '')
      return (originalOpen as (...values: unknown[]) => void).apply(this, args)
    }
    XMLHttpRequest.prototype.send = function (...args: unknown[]) {
      const state = this as XMLHttpRequest & {
        __lhBinanceProbeUrl?: string
        __lhBinanceProbeMethod?: string
      }
      const url = state.__lhBinanceProbeUrl
      const candidate =
        targets.length > 0 &&
        isCandidate(url, state.__lhBinanceProbeMethod ?? 'GET')
      if (candidate && url) {
        const requestBody = readBody(
          undefined,
          (args[0] ?? null) as BodyInit | null,
        )
        this.addEventListener('load', () => {
          void requestBody.then(text => {
            const request = json(text)
            if (!findProbeTarget(request, targets)) return
            let response: unknown = null
            try {
              response =
                this.responseType === 'json'
                  ? this.response
                  : JSON.parse(this.responseText)
            } catch {}
            emit({ url, status: this.status, request, response })
          })
        })
      }
      return (originalSend as (...values: unknown[]) => void).apply(this, args)
    }
  },
})
```

Format the file with Biome. If TypeScript's DOM overloads require a localized
cast for the `open`/`send` wrappers, mirror the existing cast in
`capture.content.ts`; do not widen any shared type.

- [ ] **Step 5: Store observations in the background with strict bounds**

Add constants:

```ts
const MAX_BINANCE_PROBE_OBSERVATIONS = 100
const BINANCE_PROBE_TTL_MS = 24 * 60 * 60 * 1000
```

Import `CAPTURE_DEBUG`, `parseProbeObservation`,
`reservedBinanceProbeTargets`, and the observation type. Add these helpers next
to the existing capture queue helpers:

```ts
function binanceProbeKey(observation: BinanceProbeObservation): string {
  return JSON.stringify([
    observation.method,
    observation.path,
    observation.status,
    observation.target,
    observation.requestShape,
    observation.responseShape,
  ])
}

async function liveBinanceProbeObservations(): Promise<
  BinanceProbeObservation[]
> {
  if (!CAPTURE_DEBUG) return []
  const cutoff = Date.now() - BINANCE_PROBE_TTL_MS
  const stored =
    (await sessionStore.get('binanceSquareProbeObservations')) ?? []
  const live = stored
    .map(parseProbeObservation)
    .filter((item): item is BinanceProbeObservation => item !== null)
    .filter(item => Date.parse(item.capturedAt) >= cutoff)
    .slice(-MAX_BINANCE_PROBE_OBSERVATIONS)
  if (live.length !== stored.length) {
    await sessionStore.set('binanceSquareProbeObservations', live)
  }
  return live
}

async function appendBinanceProbeObservation(value: unknown): Promise<void> {
  if (!CAPTURE_DEBUG) return
  const observation = parseProbeObservation(value)
  if (!observation) return
  const index = (await sessionStore.get('binanceSquareTasks')) ?? {
    byContentId: {},
    byAuthorId: {},
  }
  const allowed = reservedBinanceProbeTargets(index)
  if (
    !allowed.some(
      target =>
        target.kind === observation.target.kind &&
        target.id === observation.target.id,
    )
  ) {
    return
  }
  const existing = await liveBinanceProbeObservations()
  const key = binanceProbeKey(observation)
  const next = existing.filter(item => binanceProbeKey(item) !== key)
  next.push(observation)
  await sessionStore.set(
    'binanceSquareProbeObservations',
    next.slice(-MAX_BINANCE_PROBE_OBSERVATIONS),
  )
}
```

Handle the RPCs:

```ts
    if (req.type === 'get-binance-probe-targets') {
      const index = (await sessionStore.get('binanceSquareTasks')) ?? {
        byContentId: {},
        byAuthorId: {},
      }
      return {
        type: 'binance-probe-targets',
        targets: reservedBinanceProbeTargets(index),
      }
    }
    if (req.type === 'report-binance-probe-observation') {
      await appendBinanceProbeObservation(req.observation)
      return { type: 'ack' }
    }
    if (req.type === 'export-binance-probe-observations') {
      return {
        type: 'binance-probe-observations',
        observations: await liveBinanceProbeObservations(),
      }
    }
    if (req.type === 'clear-binance-probe-observations') {
      await sessionStore.set('binanceSquareProbeObservations', [])
      return { type: 'ack' }
    }
```

Keep these handlers structurally separate from `handleEngagementCapture` and
`verifyOnly`. They must not call GraphQL; the discovery probe therefore cannot
reach backend capture or reward code.

- [ ] **Step 6: Broadcast task refreshes to Binance tabs**

For `tasks-updated`, change the tab URL list to:

```ts
[
  '*://x.com/*',
  '*://twitter.com/*',
  'https://www.binance.com/*/square/*',
  'https://www.binance.com/square/*',
]
```

- [ ] **Step 7: Run the extension safety regression**

```bash
pnpm test -- src/lib/__tests__/binance-square-probe.test.ts \
  src/lib/__tests__/messaging.test.ts \
  src/lib/__tests__/engagement-capture.test.ts
pnpm typecheck
pnpm lint
```

Expected: all selected tests PASS; typecheck and lint exit 0.

- [ ] **Step 8: Commit the probe runtime**

```bash
git add wxt.config.ts \
  src/entrypoints/binance-square-probe.content.ts \
  src/entrypoints/binance-square-bridge.content.ts \
  src/types/messages.ts src/lib/messaging.ts \
  src/entrypoints/background.ts src/lib/binance-square-probe.ts \
  src/lib/__tests__/binance-square-probe.test.ts
git commit -m "feat: capture sanitized Binance Square fixtures"
```

### Task 7: Add a beta-only fixture export panel

**Files:**

- Modify: `lhdao-extension/src/entrypoints/options/App.tsx`
- Create: `lhdao-extension/src/entrypoints/options/BinanceProbePanel.test.tsx`

- [ ] **Step 1: Write the failing UI test**

Extract `BinanceProbePanel` as a named component from `App.tsx` and test:

```tsx
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { BinanceProbePanel } from './App'

vi.mock('@/lib/capture-debug', () => ({ CAPTURE_DEBUG: true }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

describe('BinanceProbePanel', () => {
  let root: Root | null = null
  let container: HTMLDivElement
  const writeText = vi.fn(async () => undefined)

  beforeEach(() => {
    fakeBrowser.reset()
    document.body.replaceChildren()
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    fakeBrowser.runtime.onMessage.addListener(async message => {
      if (message?.type === 'export-binance-probe-observations') {
        return {
          type: 'binance-probe-observations',
          observations: [{ id: 'o1', path: '/bapi/example' }],
        }
      }
      return { type: 'ack' }
    })
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
  })

  it('copies only exported sanitized observations', async () => {
    root = createRoot(container)
    await act(async () => root?.render(<BinanceProbePanel />))
    const button = Array.from(container.querySelectorAll('button')).find(
      item => item.textContent?.includes('复制脱敏 fixtures'),
    )
    expect(button).toBeInstanceOf(HTMLButtonElement)
    await act(async () => (button as HTMLButtonElement).click())
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        JSON.stringify([{ id: 'o1', path: '/bapi/example' }], null, 2),
      ),
    )
  })
})
```

- [ ] **Step 2: Run the UI test and confirm failure**

```bash
pnpm test -- src/entrypoints/options/BinanceProbePanel.test.tsx
```

Expected: FAIL because `BinanceProbePanel` is not exported.

- [ ] **Step 3: Implement the beta-only panel**

Import `CAPTURE_DEBUG` and add the focused component:

```tsx
export function BinanceProbePanel() {
  const [count, setCount] = React.useState(0)
  const [copied, setCopied] = React.useState(false)

  const load = React.useCallback(async () => {
    const response = await sendMessage({
      type: 'export-binance-probe-observations',
    })
    if (response.type !== 'binance-probe-observations') return []
    setCount(response.observations.length)
    return response.observations
  }, [])

  React.useEffect(() => {
    if (CAPTURE_DEBUG) void load()
  }, [load])

  if (!CAPTURE_DEBUG) return null

  const copy = async () => {
    const observations = await load()
    await navigator.clipboard.writeText(JSON.stringify(observations, null, 2))
    setCopied(true)
  }
  const clear = async () => {
    await sendMessage({ type: 'clear-binance-probe-observations' })
    setCount(0)
    setCopied(false)
  }

  return (
    <section className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950">
      <h2 className="font-bold">Binance Square beta 脱敏探针</h2>
      <p className="mt-2 text-xs">
        {count} 条。仅存于 chrome.storage.session，24 小时过期，不会自动上传。
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void copy()}>
          {copied ? '已复制' : '复制脱敏 fixtures'}
        </button>
        <button type="button" onClick={() => void clear()}>
          清空
        </button>
      </div>
    </section>
  )
}
```

Render `<BinanceProbePanel />` immediately after `<SensitiveToggleCard />` in
`App`. Do not add a JSON editor, raw network viewer, or production feature
flag.

- [ ] **Step 4: Run UI and full extension checks**

```bash
pnpm test -- src/entrypoints/options/BinanceProbePanel.test.tsx
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all tests PASS; typecheck, lint, and build exit 0.

- [ ] **Step 5: Commit the beta export UI**

```bash
git add src/entrypoints/options/App.tsx \
  src/entrypoints/options/BinanceProbePanel.test.tsx
git commit -m "feat: export Binance Square beta fixtures"
```

### Task 8: Verify the end-to-end shadow boundary and collect fixtures

**Files:**

- No production source changes are expected.
- Create fixture files only after manual collection under `lhdao-extension/src/lib/__tests__/fixtures/binance-square/`.

- [ ] **Step 1: Run backend verification**

```bash
cd /Users/kkruis/Desktop/project/backend/.worktrees/binance-square-shadow-20260803
pnpm exec prisma validate
pnpm run type-check
pnpm test -- --runInBand \
  src/modules/unified-campaign/util/binance-square-target.util.spec.ts \
  src/modules/unified-campaign/service/campaign.service.spec.ts \
  src/modules/plugin-verify/plugin-verify.spec.ts
pnpm run build
```

Expected: all commands exit 0. The plugin verification regression proves this milestone did not change signed X proof behavior.

- [ ] **Step 2: Run extension verification**

```bash
cd /Users/kkruis/Desktop/project/lhdao-extension/.worktrees/plan-a-advisory-validation-20260801
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm verify:manifests
```

Expected: all commands exit 0; the production manifest contains Binance host scope but the runtime probe returns immediately because `CAPTURE_DEBUG` is false.

- [ ] **Step 3: Create internal beta post campaigns**

Against beta GraphQL with an allowlisted internal buyer's normal web JWT, run:

```graphql
mutation CreateBinanceShadow($input: CreateUnifiedCampaignInput!) {
  createUnifiedCampaign(input: $input) {
    id
    platform
    targetUrl
    targetContentId
    targetAuthorId
    actions {
      actionType
    }
  }
}
```

Use these variables for the first run:

```json
{
  "input": {
    "type": "ENGAGEMENT",
    "platform": "BINANCE_SQUARE",
    "targetUrl": "https://www.binance.com/en/square/post/335389698745313",
    "totalBudget": 2,
    "seats": 1,
    "tierSeats": { "E": 1 },
    "targetTiers": ["E"],
    "mode": "OPEN",
    "actions": [
      { "actionType": "LIKE", "baseReward": 1, "targetCount": 1 }
    ]
  }
}
```

Repeat with `COMMENT` and `SHARE`. Use the returned campaign ID with:

```graphql
mutation ReserveBinanceShadow($campaignId: String!) {
  reserveEngagementSlot(campaignId: $campaignId) {
    reserved
    reservedTier
  }
}
```

Reserve each campaign with the internal test
user before opening Binance Square. With
`BINANCE_SQUARE_FOLLOW_PROBE_ENABLED` absent, confirm a FOLLOW mutation returns
`BINANCE_FOLLOW_DISCOVERY_PENDING`.

- [ ] **Step 4: Collect positive and negative observations**

For LIKE, COMMENT, and SHARE, perform each action once successfully and once
with a deliberate non-success outcome where safe, such as undoing the action
and repeating it. For FOLLOW discovery, first use browser DevTools manually to
identify the numeric author identifier used by the profile interaction request.
Restart only the beta backend with
`BINANCE_SQUARE_FOLLOW_PROBE_ENABLED=true`, create the internal FOLLOW campaign
with that identifier in `targetAuthorId`, reserve it, and then perform FOLLOW
and unfollow once. Never enable this flag in production.

At every point confirm:

- options shows only `/bapi/...` paths and sanitized shapes;
- no comment text, Binance UID, cookie, token, query string, header, or raw body appears;
- backend `reportEngagementCapture`, `submitEngagementProof`, verify queue, participant status, and LUX balances are unchanged;
- X capture and verification still work.

- [ ] **Step 5: Save deterministic sanitized fixtures**

Create exactly these files from the exported observations, formatting with Biome and replacing runtime observation IDs/timestamps with fixed test values:

```text
src/lib/__tests__/fixtures/binance-square/like-success.json
src/lib/__tests__/fixtures/binance-square/comment-success.json
src/lib/__tests__/fixtures/binance-square/share-success.json
src/lib/__tests__/fixtures/binance-square/follow-discovery.json
```

If no safe follow request can be tied to a stable author identifier, `follow-discovery.json` must contain the sanitized profile/request shapes that demonstrate the gap; it must not invent an ID mapping.

- [ ] **Step 6: Run a secret scan over fixtures**

```bash
rg -n -i "cookie|authorization|csrf|token|private comment|set-cookie|query" \
  src/lib/__tests__/fixtures/binance-square
```

Expected: no matches. Manually inspect every string scalar; only sanitizer markers, fixed paths, methods, statuses, field names, and fixed timestamps are allowed.

- [ ] **Step 7: Commit the fixtures separately**

```bash
git add src/lib/__tests__/fixtures/binance-square
git commit -m "test: add sanitized Binance Square fixtures"
```

- [ ] **Step 8: Stop before reward implementation**

Write the next plan from the four collected fixture outcomes. It must define exact endpoint allowlists, business-success predicates, target/result ID paths, Binance UID binding, signed platform proof vectors, revocation signals, per-action `shadow/enforce/paused` modes, and the 100-sample/98% rollout gate. Do not enable Binance proof submission or rewards in this milestone.

## Final acceptance checklist

- [ ] Existing X campaign creation, task indexing, capture, signed proof, and settlement tests remain green.
- [ ] Binance campaign rows have `platform=BINANCE_SQUARE` and generic target fields; X rows default to `platform=X`.
- [ ] Only reserved Binance targets are sent from ISOLATED to MAIN.
- [ ] Production builds cannot persist probe observations because the beta guard returns before interception.
- [ ] Probe observations contain no raw values other than public configured target equality markers.
- [ ] No Binance observation reaches GraphQL, the verify queue, participant completion, or LUX settlement.
- [ ] Sanitized fixtures exist for LIKE, COMMENT, SHARE, and FOLLOW discovery.
- [ ] The next authoritative implementation remains blocked until those fixtures are reviewed.
