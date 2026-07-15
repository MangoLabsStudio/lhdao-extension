# Lighthouse Browser Extension Privacy Policy

Effective date: 2026-07-13

This policy describes data handled by the Lighthouse browser extension for
Chrome, Edge, and Firefox. Lighthouse uses its own service at
`service.lhdao.top`; it does not include third-party analytics or advertising
SDKs.

## 1. Data stored in the browser

The extension stores the following data in extension-controlled storage:

- A Lighthouse plugin token in `storage.local`. The token remains isolated from
  page JavaScript and is used to authenticate requests to the Lighthouse
  service.
- Cached Lighthouse account and task summaries used by the popup and X task
  interface.
- Short-lived engagement capture state and Product Experience task/session
  state. Product Experience credentials are stored in `storage.session`, not in
  cookies, page `localStorage`, or page `sessionStorage`.

Removing the extension clears extension-controlled local data. A token can also
be revoked from Lighthouse account settings.

## 2. Data sent to Lighthouse

The extension sends data only to the configured Lighthouse API. Depending on
the feature used, this can include:

- The plugin token as a Bearer authentication credential.
- Lighthouse campaign IDs, reservation/verification results, task progress,
  and account/task synchronization requests.
- For X engagement verification: action type, relevant tweet ID or account
  handle, capture time, and—when a comment task is completed—the comment text
  needed for task delivery or review.
- For eligible X tweet detail pages: visible dwell duration and related tweet
  metadata used as an anti-abuse signal. Background-tab or minimized-window
  time is excluded.
- For Product Experience verification: matched Buyer rule IDs, match times,
  allowed origin, a hash of the URL path, and cryptographic proof material used
  to prevent forgery and replay.

Lighthouse does not sell this data or send it to advertising or analytics
providers.

## 3. Product Experience temporary page access

The manifest does not request persistent access to customer websites. Product
Experience verification works as follows:

1. The user opens a customer page and clicks **Start verification** in the
   Lighthouse popup.
2. That user gesture grants temporary `activeTab` access to the current tab.
3. The extension uses `scripting` to inject an isolated evaluator into the
   top-level page for that authorization.
4. The evaluator checks only the declarative rules configured by the Buyer:
   element existence, element visibility, an exact attribute value, or whether
   visible element text contains an expected marker.
5. Navigating to another origin requires a new explicit popup click.

For Product Experience `TEXT_CONTAINS`, page text is compared in memory and is
not included in the proof. Product Experience proof submission does **not**
upload page text, matched text, selectors, DOM/HTML, cookies, form values, input
values, iframe contents, query strings, or URL fragments.

This Product Experience limit does not mean the entire extension never sends
text: an X comment task may transmit the user's comment text as described in
section 2.

## 4. Browser permissions

- `storage`: stores the plugin token, cached task/account data, and short-lived
  verification state.
- `alarms`: refreshes Lighthouse tasks in the background.
- `activeTab`: grants temporary access only after the user clicks the Product
  Experience action in the popup.
- `scripting`: injects the Product Experience evaluator into that temporarily
  authorized tab.
- Host access for `x.com` and `twitter.com`: renders and verifies Lighthouse X
  engagement tasks.
- Host access for `service.lhdao.top` and `app.lhdao.top`: communicates with the
  Lighthouse API and Lighthouse web application.

The production manifest does not request `<all_urls>`, wildcard customer-host
access, or persistent customer-site permissions.

## 5. Data the extension does not access for Product Experience

The Product Experience evaluator does not access browser cookies, passwords,
form field values, complete page HTML, iframe documents, browser history,
clipboard contents, or data owned by other extensions. It does not make network
requests itself; the background service worker submits only the sanitized proof
described above.

## 6. Retention, deletion, and account controls

Browser-session data is cleared by the browser or when the Product Experience
session reaches a terminal state. Server-side campaign and verification records
are retained as needed to operate Lighthouse tasks, prevent replay and abuse,
resolve disputes, and meet applicable obligations.

Users can revoke a plugin token from Lighthouse settings. For account data
access or deletion requests, contact `support@lhdao.top`. The Lighthouse service
privacy notice is available at
[https://app.lhdao.top/legal/privacy](https://app.lhdao.top/legal/privacy).

## 7. Policy changes

Material changes will update this file and its effective date. Store submission
metadata must link to the public version of this file:

<https://github.com/MangoLabsStudio/lhdao-extension/blob/main/PRIVACY.md>

## 8. Contact

Questions about this policy can be sent to `support@lhdao.top`.
