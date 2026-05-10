# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project

**Lighthouse browser extension** — Manifest V3 extension that highlights
Lighthouse engagement tasks on the X (Twitter) timeline. Workflow:

1. KOL browses X timeline
2. Background SW polls Lighthouse backend every 60s for active tasks
3. Content script matches tweet IDs and injects a "1-click" chip
4. KOL clicks chip → reserve slot + verify completion + earn LUX

The extension is a thin client around the Lighthouse `service.lhdao.top`
GraphQL API. All business logic stays on the backend.

## Tech Stack

- **WXT 0.20+** — extension framework (Vite under the hood, "Next.js for
  extensions")
- **React 19** + TypeScript
- **Tailwind 4** via `@tailwindcss/vite` — Shadow DOM-injected for content
  script chip
- **Manifest V3** — service worker (not persistent background page)
- **chrome.alarms** for the 60s sync interval
- **chrome.storage.local** for token + cached tasks
- **Vitest** for unit tests
- **Biome** for lint + format

## Commands

```bash
pnpm run dev          # WXT dev server, auto-loads to Chrome
pnpm run dev:firefox  # Firefox dev mode
pnpm run build        # → .output/chrome-mv3/
pnpm run build:edge   # → .output/edge-mv3/
pnpm run zip          # produce release zip
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # biome check
pnpm run lint:fix     # biome check --write
pnpm run test         # vitest run
```

## Code Style

- Biome 2.x: single quotes, no semicolons, 2-space indent, 80 char width
- Inline GraphQL strings with manually-typed result types (matches the lhdao
  monorepo pattern — codegen is broken upstream)
- All network requests go through the **background service worker** —
  content script and popup never `fetch()` directly. They send chrome
  messages and the SW does the actual HTTP call.
- Path alias: `@/*` → `src/*`

## Architecture

```
src/
├─ entrypoints/
│  ├─ background.ts      # SW: alarms / storage / fetcher / RPC handler
│  ├─ content/index.ts   # injected on x.com, twitter.com
│  ├─ popup/index.html   # browser action popup
│  └─ options/index.html # token entry, debug toggles
├─ components/
│  └─ chip/              # Shadow DOM React component (the highlight chip)
├─ lib/
│  ├─ env.ts             # __API_ENDPOINT__ (compile-time inject)
│  ├─ graphql.ts         # fetch wrapper, throws on errors
│  ├─ messaging.ts       # typed RPC between content↔BG
│  ├─ storage.ts         # chrome.storage typed wrapper
│  └─ tweet-id.ts        # extract /username/status/<id> from DOM
└─ styles/
   └─ global.css         # @import 'tailwindcss' + @theme tokens
```

## Backend

GraphQL endpoint:
- **prod:** `https://service.lhdao.top/graphql`
- **dev:**  `https://service.lhdaobeta.top/graphql`
- override compile-time via `WXT_API_ENDPOINT` env var

Auth: `Authorization: Bearer lhdao_pk_<32-byte-base64url>` — user creates a
token at `https://lhdao.top/settings/plugin-tokens` and pastes it into the
extension's options page.

CORS: backend whitelists `chrome-extension://[a-z]{32}` (the deterministic
extension ID from `web_accessible_resources` keying).

## Security boundaries

- Plugin token equals account-level access. Treat as a password.
- Token lives in `chrome.storage.local` only — never `localStorage` (subject
  to XSS) and never sent to the content script (which runs in an isolated
  world but on a hostile page). Content script uses messaging RPC to ask
  the background SW to do auth'd calls.
- Content script's chip lives in **Shadow DOM** — Twitter CSS cannot reach
  in, our CSS cannot leak out, and Twitter JS cannot manipulate it.
- `host_permissions` is the minimum: x.com / twitter.com /
  service.lhdao.top / service.lhdaobeta.top. No `<all_urls>`.

## Related repos

- **lhdaov3** (private, monorepo) — backend (`kol-dao-service`) + web app
  (`kol-dao-app`). Extension reuses backend GraphQL contract.
- **lighthouse-skill** (public) — Claude Code skill exposing the Open API.
