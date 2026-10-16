# X analytics response capture implementation plan

Goal: Read the page's own 3M response and retain account, period and save validation.
Architecture: Reuse the existing MAIN-world fetch/XHR observer. A pure parser only accepts the named daily overview query on exact X hosts and its current 90-day variables. Forward a bounded normalized result to the isolated analytics dialog; no headers, cookies, tokens, raw responses, or unrelated requests cross the bridge. Page messages remain untrusted client evidence.
Tech stack: WXT, TypeScript, Vitest; no new permissions or dependencies.

Evidence: X public bundle.AccountAnalytics.557531d18bd081ada.js (2026-10-16) defines accountOverviewDailyQuery, viewer_v2.user_results.result, current_time_series, hourly_backfill, relationship_counts.followers and verified_follower_count. Request range uses UTC milliseconds and an exclusive end. Trailing days without impressions use hourly_backfill. Engagements are Bookmark, Fav, ProfilePic, QuoteTweet, Reply, Retweet and Share. 3M is 90 days. No successful authenticated daily response is available yet: X page errors before requesting it; app_context.json is error logging, not analytics.

- [x] Add parser tests for exact hosts/operation, range, malformed/partial/error responses, metric totals, trailing-day replacement and identity; watch failures then implement src/lib/x-analytics-network.ts.
- [x] Add observer tests for fetch/XHR response preservation, bounded forwarding, failures and unrelated requests; implement isolated MAIN observer module and call from capture.content.ts.
- [x] Connect document-start listener and response waiter in x-analytics.content.ts; retain 3M selection and bound-user checks, classify API errors, and never save an unmatched response. Test the real bridge through the dialog without mocking its parser.
- [x] Run full tests, typecheck, lint, production build and manifest verification. Create a new immutable package only after checks pass. Do not claim live acceptance until a real successful 3M response and backend save have been verified.

User deferred live acceptance until the current X analytics page recovers. Candidate remains uninstalled and must not be described as live-verified. Date-range regression also covers midnight changes between response capture and save.

Verification: 42 test files / 411 tests, typecheck, lint, diff check, Chrome production build, manifest and ZIP integrity passed. Packaged 0.4.20 production-config candidate; not installed or pushed.
