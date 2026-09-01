# zkTLS Beta Popup Diagnostics Design

## Goal

Make a stalled or failed Product Check explain itself inside the Lighthouse
popup. A tester must see what the extension did, what it captured, and the
exact failure returned by the failing layer without opening DevTools.

This is a Beta-only MVP. It changes no proof rule, Backend API, Verifier
protocol, database schema, or production UI.

## User experience

The existing Product Check card gains an expandable `验证过程` section. It
shows the current attempt as an ordered timeline:

1. button request received;
2. page watcher injected;
3. watcher bootstrapped and current origin accepted;
4. each Buyer DOM rule evaluated;
5. matching evidence sent to the background;
6. proof session created;
7. request captured;
8. response captured and validated;
9. Verifier registration, proof reveal, and completion finished;
10. success or the exact failing stage.

Clicking `继续证明` immediately changes the visible state to
`正在检查页面`. It never returns silently to an identical `等待证明` card.

If a DOM rule does not match, the timeline shows its title, selector, URL match,
matched element count, condition type, and result. It does not print matched DOM
text or attributes unless the signed rule explicitly compares that value.

When capture begins, the panel exposes two collapsed blocks:

- `捕获的请求`: method, URL, headers, body, resource type, and captured slots;
- `捕获的响应`: status, headers, wire body, decoded body, and byte counts.

Failures expand the relevant block and show the exact error code, error name,
message, stack, and last completed stage. The UI does not translate or replace
the error with a generic message. It only redacts credentials.

The panel includes `复制诊断`. Copying produces the same ordered, redacted
payload shown in the popup.

## Diagnostic data

Use one bounded diagnostic record on the active Product Experience session.
Do not create a second task model or a new event service. The record contains:

```ts
interface ProductExperienceDiagnostic {
  correlationId: string
  startedAt: number
  updatedAt: number
  events: ProductExperienceDiagnosticEvent[]
}

interface ProductExperienceDiagnosticEvent {
  at: number
  stage: string
  status: 'running' | 'passed' | 'failed'
  details?: unknown
  error?: unknown
}
```

Keep only the current attempt and a fixed maximum of 30 events. The existing
session storage preserves the record while the popup closes and clears it with
the Product Experience session. Do not write diagnostics to durable local
storage, Backend, Verifier, analytics, or logs outside the extension.

All extension boundaries report into this record:

- popup reports the click and any message transport error;
- background reports start, injection, bootstrap, evidence, queue, and backend
  session stages;
- content script reports origin and rule evaluation results;
- offscreen worker forwards the existing proof trace instead of keeping it only
  in its DevTools console.

The popup reads diagnostics through the existing controller state request and
state-change broadcast. No polling endpoint or new server request is needed.

## Capture and error safety

Show public request and response data exactly as captured. Preserve raw error
codes and messages. Before the data reaches session storage or UI, apply the
existing zkTLS sanitizer:

- replace Cookie, Set-Cookie, Authorization, Proxy-Authorization, tokens,
  secrets, HMAC values, MAC keys, and wallet signatures with `[REDACTED]` plus
  their length;
- redact the same secret value if it appears inside an error message or stack;
- inspect own data properties without invoking accessors;
- represent binary bodies as base64;
- preserve public JSON and HTTP metadata;
- cap each serialized detail block at 65,536 bytes and mark truncation.

Redaction is the only allowed modification to an error. The UI must not map a
technical error to friendly copy in the diagnostic panel.

## Build boundary

Enable the panel only when the existing compile-time zkTLS diagnostic profile
is active: zkTLS enabled, Beta API endpoint, and `WXT_ZKTLS_DEBUG=true`.
Ordinary Beta and production builds keep the current public Product Check UI
and carry no active diagnostic collection.

## Failure behavior

Diagnostics never affect proof input, page matching, retry, validation,
disclosure, completion, or result persistence. A diagnostic write failure is
ignored by the proof path and may only produce a local `diagnostic-write-failed`
console entry.

The visible attempt ends in `failed` at the first failing layer. The action
button then becomes `重试证明`. A retry replaces the previous attempt rather
than appending an unbounded history.

## Tests

Use strict TDD and cover these behaviors:

- clicking `继续证明` immediately creates a visible running event;
- successful injection and bootstrap appear before DOM evaluation;
- selector miss and condition mismatch show exact rule diagnostics;
- matching evidence advances into queue and proof stages;
- request and response blocks show public bodies and metadata;
- thrown errors preserve code, name, message, stack, and failing stage;
- credential values never reach state, rendered text, copied text, or storage;
- popup close and reopen retains the current attempt;
- retry replaces the prior attempt;
- diagnostic writer failures do not change proof behavior;
- debug-disabled and production profiles collect and render nothing;
- existing Product Experience, zkTLS, privacy, type-check, and Chrome Beta build
  gates remain green.

## Acceptance test

Build the unpacked Beta extension with `WXT_ZKTLS_DEBUG=true`, reload it, open
Nado, and click `继续证明` once.

Before a proof starts, the popup must identify whether injection, bootstrap,
origin validation, selector matching, or condition evaluation stopped the
flow. After capture starts, it must show the redacted request and response and
the exact failing proof error. A tester must not need DevTools to identify the
failing component.
