# Task Verification Panel Remount Design

## Problem

The verification panel is inserted only while a matching focal tweet is first
mounted. X can replace the tweet controls after navigation or reply activity,
and the task snapshot can arrive after the article mount. In either case, the
article remains recorded as mounted, but the panel is absent.

## Design

Keep one verification-panel host for the focal tweet. Reconcile that host on
each existing scan: create it when the focal tweet controls appear, move the
same host when X replaces the article or action row, and remove it when the
user leaves the tweet. The panel itself continues to load and select the task
from the background snapshot, so host placement does not depend on snapshot
timing.

Do not restore the retired floating overlay or add a second verification UI.

## Failure Handling

If the focal tweet or its action row is temporarily absent, detach the host
without destroying its React state. A later scan reattaches it. If the focal
tweet changes, unmount the old root and create a new panel for the new tweet.

## Verification

- A focused tweet receives the panel even when its task snapshot is delayed.
- Replacing the tweet article or action row preserves and reattaches the panel.
- Leaving the tweet removes the panel.
- Existing task selection, action detection, dwell timing, and verification
  behavior remain unchanged.

