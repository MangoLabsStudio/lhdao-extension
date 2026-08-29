# Product Experience Continue Proof Design

## Problem

A zkTLS rule can need more than one proof. The first proof may establish an
account binding while the next proof supplies the metric that completes the
same rule. After the backend reports `PARTIAL`, it may immediately expose the
next connector as `PENDING`; a newly restored session may also have an empty
progress list until its first backend poll. The popup offers no action in any
of those states. The page watcher emits each rule only once, so the user cannot
start the next proof without reloading the page.

## Decision

Show `继续证明` when all of these conditions hold:

- the controller is observing the current authorized site;
- the controller state identifies a zkTLS session by including its progress
  field, even when the list is not populated yet;
- no retryable proof error is present.

The button reuses the existing `start-product-experience` action. That action
checks the active tab and origin, reinjects the existing content watcher, and
therefore evaluates the current page again before sending evidence. It does
not bypass page matching or enqueue a proof directly.

## Alternatives

1. **Reuse the existing start action — chosen.** This is the smallest change
   and preserves the current authorization, injection, and evidence checks.
2. Automatically clear the watcher's rule cache after `PARTIAL`. Rejected
   because a frequently changing page could start repeated proofs without a
   user decision.
3. Add a new popup-to-content rescan protocol. Rejected because the existing
   start action already performs the required checked reinjection.

## User Experience

The status remains `部分完成` or `等待证明`. A `继续证明` button appears in the
existing action area. While the action runs, the existing busy state prevents
duplicate clicks. Existing actions keep their precedence: authorization and
failed or expired proof recovery still show their current labels.

## Safety and Compatibility

- The active tab must still match the authorized origin.
- The content watcher must still match the signed Buyer rule.
- The backend still chooses and signs the next connector.
- No automatic retry loop, new storage field, protocol message, permission,
  dependency, or backend change is introduced.
- V1 and V3 proof behavior is unchanged.

## Tests

- A popup state containing `PARTIAL` renders `继续证明`.
- A popup state containing the next stage as `PENDING` renders `继续证明`.
- A newly restored zkTLS session with an empty progress list renders `继续证明`.
- Clicking it sends the existing `start-product-experience` request once.
- Retryable errors still render `重试证明`, not `继续证明`.
- Existing popup and Product Experience controller suites remain green.
