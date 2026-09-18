# Plugin Device Recovery Design

## Problem

Older plugin tokens can predate device-key binding. The current extension signs
allowlisted GraphQL requests with its local device key. When the backend cannot
find an active device for that token and device ID, it returns
`PLUGIN_DEVICE_DENIED`. Sync and promotion then stop, although the popup still
shows `CONNECTED` because a token remains in local storage.

## Goal

Give affected users a safe, explicit recovery path. A user can start one-click
pairing from the error state. Pairing creates a new token bound to the current
device. The extension replaces the local token only after pairing succeeds.

## Non-goals

- Do not weaken backend device verification.
- Do not silently bind an old token to a new device.
- Do not delete the local token before pairing succeeds.
- Do not add a new backend migration endpoint.

## Approaches Considered

### 1. Explicit re-pairing in the extension

Detect `PLUGIN_DEVICE_DENIED`, explain that device authorization expired, and
offer a reconnect action. This reuses the existing pairing flow and keeps the
old token until the new token is ready.

This is the selected approach. It preserves the security boundary and needs no
new backend behavior.

### 2. Silent token removal and automatic pairing

This reduces clicks but unexpectedly changes account state and can leave the
extension disconnected if the user closes the authorization page.

### 3. One-time backend self-binding for old tokens

This could preserve the token, but it weakens the device-binding boundary and
adds a security-sensitive migration endpoint. The extension already has a safe
pairing flow, so this complexity is unnecessary.

## Design

Add one small shared helper that recognizes `PLUGIN_DEVICE_DENIED` in GraphQL
error text. Use it in the popup and promotion dialog.

The popup error banner will show:

- title: `设备授权已失效`
- hint: `此 Token 未绑定当前浏览器，请重新连接。`
- action: `重新连接`

The reconnect action sends the existing `start-pairing` message. The background
worker opens the authorization page and polls anonymously. It leaves the old
token in storage while pairing is pending. When polling returns `READY`, it
stores the newly issued token. The existing storage listener then runs sync.

The promotion dialog will replace the raw device error with the same plain
language and offer the same reconnect action. A rejected promotion never
reaches the spending resolver, so the dialog must not imply that an order or
charge occurred.

Other errors keep their current behavior.

## Failure Handling

- If pairing fails or times out, keep the old token and allow another attempt.
- If the user cancels, keep the old token and return to the device-error state.
- If pairing succeeds, replace the local token and let background sync confirm
  the new connection.
- Never retry the rejected promotion automatically. The user must submit it
  again after reconnection, which prevents duplicate spending.

## Tests

Add unit coverage for exact and HTTP-prefixed `PLUGIN_DEVICE_DENIED` messages
and for unrelated errors. Existing pairing-query tests continue to prove that
new pairings send the device ID and public key. Run the focused tests, the full
Vitest suite, type checking, and the production extension build.

