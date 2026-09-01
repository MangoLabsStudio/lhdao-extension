# Product zkTLS handoff diagnostics

## Goal

Expose the silent handoff between a matched page rule and zkTLS capture. A
failed handoff must leave a useful popup diagnostic instead of returning to
`waiting` without an explanation.

## Scope

Add four diagnostic boundaries to the existing Beta diagnostic stream:

1. `evidence-sent`: the content script sent sanitized rule matches.
2. `evidence-accepted`: the background controller validated those matches and
   queued them.
3. `proof-session-requested`: the controller asked Lighthouse for a signed
   zkTLS session.
4. `proof-session-failed`: that request failed before capture started.

The existing `capture-started` event remains the next success boundary. The
change does not alter page rules, Nado configuration, GraphQL contracts, proof
protocols, retry policy, or verifier behavior.

## Error handling

Reuse the current diagnostic error sanitizer. Show the original error name,
message, code, and stack when safe. Continue redacting credentials, cookies,
authorization values, tokens, request bodies, and captured response bodies.

If the content-to-background evidence message rejects, attempt one diagnostic
message before stopping the watcher. If the signed-session request rejects,
record `proof-session-failed`, reset the queued item through the existing path,
and keep the failure visible in the popup.

## Tests

- A rejected evidence message records the dispatch failure instead of stopping
  silently.
- Valid evidence records `evidence-accepted` before queue draining.
- A signed-session request records `proof-session-requested`.
- A rejected signed-session request records `proof-session-failed` with a safe
  direct error and does not expose credential-like values.
- The existing successful path continues from these events to
  `capture-started` without changing proof behavior.

## Non-goals

- No provider-specific code.
- No new logging service, storage model, retry engine, or dependency.
- No raw HTTP transcript in durable storage or public UI.
