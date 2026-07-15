# Lighthouse extension publishing checklist

This document covers version `0.2.0` Chrome, Edge, and Firefox MV3 artifacts.
GitHub Releases are automated; browser-store submission remains a reviewed
manual step.

## 1. Release gate

Run from a clean checkout with Node 20+ and the pnpm version declared in
`package.json`:

```bash
pnpm install --frozen-lockfile
pnpm run compile
pnpm run test
pnpm run typecheck
pnpm run lint

unset WXT_LOCAL_BUILD
export WXT_API_ENDPOINT=https://service.lhdao.top/graphql
export WXT_WEB_ENDPOINT=https://app.lhdao.top
pnpm run zip
pnpm run zip:edge
pnpm run zip:firefox
```

Extract the three final store zips and verify those extracted directories, not
only the intermediate `.output/*-mv3` build directories:

```bash
VERSION="$(node -p "require('./package.json').version")"
rm -rf release/unpacked
mkdir -p release/unpacked/{chrome,edge,firefox}
unzip -q ".output/lhdao-extension-${VERSION}-chrome.zip" -d release/unpacked/chrome
unzip -q ".output/lhdao-extension-${VERSION}-edge.zip" -d release/unpacked/edge
unzip -q ".output/lhdao-extension-${VERSION}-firefox.zip" -d release/unpacked/firefox
node scripts/verify-product-manifests.mjs \
  --chrome-dir release/unpacked/chrome \
  --edge-dir release/unpacked/edge \
  --firefox-dir release/unpacked/firefox
shasum -a 256 \
  ".output/lhdao-extension-${VERSION}-chrome.zip" \
  ".output/lhdao-extension-${VERSION}-edge.zip" \
  ".output/lhdao-extension-${VERSION}-firefox.zip"
```

The verifier requires all three manifests to have:

- `manifest_version: 3` and package version `0.2.0`;
- exactly `storage`, `alarms`, `activeTab`, and `scripting` permissions;
- exactly the X, Twitter, production API, and production web hosts;
- no wildcard, customer, or loopback host access;
- a runtime `content-scripts/product-experience.js` artifact that is absent
  from static `content_scripts`.

## 2. Tag-driven GitHub release

The release workflow rejects a tag that is not exactly `v<package.version>`.
After all three production zip files have been built, extracted, and accepted by
the manifest verifier, record the tested commit SHA and the three SHA-256 values,
then stop. Send that evidence to the release owner. Do not create a tag until the
release owner gives explicit approval. Only after that approval:

```bash
git tag -a v0.2.0 -m "release: extension v0.2.0"
git push origin v0.2.0
```

`.github/workflows/release.yml` repeats compile, test, typecheck, lint, three
production zip builds, extraction, and manifest verification. It uploads only:

- `lhdao-extension-0.2.0-chrome.zip`
- `lhdao-extension-0.2.0-edge.zip`
- `lhdao-extension-0.2.0-firefox.zip`

The Firefox sources zip is not a store artifact and must not be uploaded as one.

## 3. Public privacy policy gate

Use this exact store privacy URL:

<https://github.com/MangoLabsStudio/lhdao-extension/blob/main/PRIVACY.md>

Before every store submission:

1. Merge the release policy to the public `main` branch.
2. Open the URL in a signed-out/private browser window.
3. Confirm it loads without authentication and shows the expected effective
   date and release behavior.
4. Confirm the store declarations match the policy and current code.

Do not claim this check passed before the commit is publicly reachable.

## 4. Permission declarations

Use the following scope descriptions consistently across stores.

### `storage`

Stores the Lighthouse plugin token, cached account/task summaries, engagement
capture state, and short-lived Product Experience session state. The plugin
token is transmitted only to the Lighthouse API as a Bearer credential.

### `alarms`

Refreshes the user's available Lighthouse tasks in the background.

### `activeTab`

Grants temporary access to the current customer tab only after the user clicks
**Start verification** or **Authorize again** in the popup. It is not persistent
customer-site access.

### `scripting`

Injects the isolated Product Experience evaluator into the tab covered by that
user-triggered `activeTab` grant. The evaluator is not a static customer-site
content script.

### Host access

- `x.com` and `twitter.com`: displays and verifies Lighthouse engagement tasks.
- `service.lhdao.top`: authenticates, synchronizes tasks, and submits task or
  sanitized Product Experience proof data.
- `app.lhdao.top`: pairs the extension and exchanges the sanitized page bridge
  state used by Lighthouse task pages.

No customer website appears in persistent host permissions.

## 5. Data-use declarations

The store declaration must cover the extension as a whole, not only Product
Experience:

- Authentication information: **Yes**. A plugin token authenticates Lighthouse
  API requests.
- User/website activity: **Yes**. X task actions and eligible visible dwell data
  are submitted for task verification and abuse prevention.
- Personal communications / website content: **Yes where applicable**. X
  comment tasks can submit the user's comment text for delivery or review.
- Product Experience website content: page markers can be read locally, but
  `TEXT_CONTAINS` text stays in memory and Product Experience proofs do not
  upload page text, DOM, selectors, cookies, or form values.
- Third-party advertising or analytics: **No**.

Do not reuse older declarations that say the token never leaves the browser,
that comments are never transmitted, or that the extension does not process
website activity.

## 6. Store-specific release notes

### Chrome Web Store

Upload the verified Chrome zip. Provide an extension-specific privacy URL and
explain every requested permission. Screenshots must use test accounts and must
not expose plugin tokens, proof material, real handles, private page content, or
customer data.

### Microsoft Edge Add-ons

Upload the separately built and verified Edge zip. Use the same permission,
privacy, and data-use statements as Chrome.

### Firefox Add-ons (AMO)

The workflow produces a verified Firefox MV3 runtime artifact, but the current
manifest is **not AMO-ready**. Before signing or AMO submission, the publisher
must:

1. Confirm whether an existing AMO listing already has a stable Gecko extension
   ID. Do not create a different ID for an update.
2. If this is a new listing, select and reserve a stable `gecko.id`.
3. Review the implemented data flows with product/legal and declare accurate
   `browser_specific_settings.gecko.data_collection_permissions`. Do not use
   `required: ['none']`.
4. Add verifier tests for the approved ID and categories, rebuild the Firefox
   zip, and rerun the full release gate.

Mozilla's current manifest requirements are documented in
[MDN browser-specific settings](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
and the
[Firefox built-in data consent guide](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## 7. Review evidence

For each submitted version, retain:

- the tag and commit SHA;
- SHA-256 hashes of the three submitted zips;
- release-gate command output;
- signed-out privacy URL verification date;
- store declaration screenshots or exported answers;
- sanitized Chrome, Edge, and Firefox Product Experience smoke-test results.
