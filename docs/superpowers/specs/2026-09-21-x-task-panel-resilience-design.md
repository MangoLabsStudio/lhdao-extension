# X Task Panel Resilience Design

## Problem

Some users reserve an engagement task in Task Hall, open its X post, and see
no Lighthouse task panel. The current extension has two silent failure paths:

1. The panel host requires an X element matching `[role="group"]`. Some X DOM
   variants expose the action buttons without that exact wrapper.
2. The panel stops its initial retries after 2.6 seconds. If the reserved task
   reaches `myReservedEngagements` later, or the `tasks-updated` message is
   missed, the component concludes that the post has no task and renders
   nothing.

The existing code already preserves a mounted panel when X replaces an article
or action row. This change keeps that behavior and closes the remaining gaps.

## Behavior

When a user opens an X post detail URL, the extension will:

- find the post action row through stable action button test IDs, with
  `[role="group"]` as the preferred path;
- keep reconciling the panel host while the detail page is active and the host
  is missing;
- retry task synchronization at 0, 1, 3, 7, and 15 seconds while no matching
  task has appeared;
- show a loading panel during this bounded arrival window;
- show a retryable error after the window expires instead of hiding the panel;
- stop timers and remove the panel after leaving the post detail route.

Once a matching task appears, the existing action detection, dwell tracking,
verification, and reward flow remain unchanged.

## Implementation

### Panel host discovery

Add one small helper in `src/entrypoints/content.ts` that finds the real action
row. It first checks groups containing known X action buttons such as reply,
retweet, and like. If no role group exists, it finds the nearest shared parent
of those buttons within the current article. The helper never searches outside
the focused article.

Use this helper for panel reconciliation. Add a low-frequency reconciliation
timer that runs only on a post detail route and only schedules a scan when the
host is absent or detached.

### Reserved task arrival

Keep task loading inside `CurrentTaskSection`. Replace the short cold-start
retry list with the bounded 0, 1, 3, 7, and 15 second schedule. A successful
empty snapshot does not end the arrival window. After the final retry, show a
clear retry action. A user retry starts a new bounded window.

The background service remains the single source of task data. The content
script will continue calling `force-sync` and reading the same task snapshot;
no new API or storage layer is introduced.

## Failure Handling

- Background RPC failure: show “任务暂时无法加载” and a retry button.
- Empty task snapshot during the arrival window: keep the loading panel
  visible and continue scheduled synchronization.
- Empty snapshot after the final retry: show “未同步到已接任务” and a retry
  button.
- Extension reload: preserve the existing refresh-page notice.
- Route change: cancel pending retries and remove the old host.

## Tests

Add focused regression coverage for:

- an action row without `[role="group"]`;
- a missing host being restored while the detail page stays open;
- a reserved task arriving after the old 2.6-second retry limit;
- a missed `tasks-updated` broadcast;
- timeout UI and manual retry;
- timer cleanup after leaving the post.

Run the focused tests first, then the full test suite, typecheck, lint, and all
browser builds with manifest verification.

## Scope

This change modifies only extension-side panel mounting and task arrival
recovery. It does not change reservation eligibility, rewards, backend business
rules, Task Hall UI, or the signed verification protocol.
