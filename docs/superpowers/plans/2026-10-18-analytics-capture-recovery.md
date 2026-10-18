# X analytics capture recovery

Approved scope: bounded automatic retries, retain valid partial data in the current session, label missing values, verify beta only.

1. Add validated partial API previews, independently retaining follower counts and complete aggregation groups. Never manufacture a complete save payload from merged previews.
2. Persist retry budget (three attempts), generation identity, preview, and immutable save payload in extension session storage. Cancel on close; reject stale reports; account/date boundaries remain enforced.
3. Retry recoverable read/network failures with backoff. Resume ambiguous saves with the same capture ID. Stop on authorization/account/validation failures and explain the reason.
4. Render retained metrics, missing labels and recovery countdown in the standalone capture window with accessible controls and reduced motion.
5. Run regression/type checks, build beta package, and verify recovery and beta integration. Keep production untouched.

## Verification completed 2026-10-18

452 tests passed; full TypeScript and touched TypeScript Biome checks passed. Beta Chrome build and manifest verification passed. Real beta capture succeeded. Injected lost-save-response and three-save-failure scenarios recovered with the same immutable capture ID, independently verified as one database snapshot each. Partial metric rendering was checked at 360px with display-only fixtures. Reviewer findings on uncertain 429 saves and stale optional follower counts were fixed with regression tests. No production deployment or application-status mutation.

Evidence: /Users/kkruis/Desktop/project/artifacts/extension-beta-0.4.23-20261018/README.md
