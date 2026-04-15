# CLAUDE.md

## What this repo is

Unduh Unduh is a Cloudflare Worker app for downloading public Instagram and TikTok media.
The Worker validates inputs, asks an extractor for downloadable media URLs, signs short-lived download links, and only proxies the final file when the user actually downloads it.

## Extraction

- Flow: `Worker -> extractor bridge -> yt-dlp`
- `scripts/local-origin-server.ts` is the bridge that shells out to `yt-dlp`.
- The Worker talks to the bridge via `EXTRACTOR_URL` using a clean yt-dlp-native API.
- `pnpm run local:publish` starts the bridge, opens a Quick Tunnel, updates Worker secrets, and deploys.
- The bridge extracts captions from yt-dlp's `description` field and returns them as `caption`.

## Client architecture

The browser UI (`src/client/`) uses `lit-html` for declarative rendering:

- **State**: A single `AppState` object holds all UI state (form inputs, options, results, download phases, mascot state, health).
- **Rendering**: `setState(partial)` merges updates into state and calls `render(appTemplate(), root)` to re-render the entire view.
- **Templates**: Each UI section is a function returning a lit-html `TemplateResult` — `appTemplate()`, `resultsAreaTemplate()`, `resultGroupTemplate()`, `downloadRowTemplate()`, `footerTemplate()`, `switcherChipTemplate()`.
- **Directives**: `classMap` for conditional CSS, `live` for textarea binding, `map` for lists, `unsafeSVG` for the mascot, `ref` for textarea auto-grow.
- **Events**: All event handlers are bound declaratively via `@click`, `@submit`, `@input`, `@focus`, `@blur`, `@paste` in templates.
- **No LitElement**: The app uses only `lit-html`, not the full Lit framework. There are no web components.

## Hard constraints

- Cloudflare Workers cannot run `child_process`, so do not move `yt-dlp` into Worker code.
- Download links must stay short-lived and signed; do not turn `/api/download` into an open proxy.
- Never commit secrets, `.dev.vars`, `.runtime/`, `.wrangler/`, build output, or local machine state.

## Repo map

- `src/client/` - browser UI (lit-html templates with reactive state)
- `src/worker/` - Worker routes, upstream client, token handling
- `src/shared/` - request/response contracts and shared helpers
- `scripts/local-origin-server.ts` — yt-dlp bridge with clean extractor API
- `scripts/*.sh` - local bridge lifecycle and publish helpers
- `tests/` - unit/integration-style tests for Worker behavior

## Conventions

- Prefer `local:*` script names. `origin:*` exists as legacy aliases.
- Keep user-facing copy plain and non-technical.
- Prefer small, high-leverage edits over broad churn.
- When architecture changes, update both `README.md` and this file.

## Useful commands

- `pnpm run verify` - full pre-push check
- `pnpm run dev` - local Worker dev server
- `pnpm run smoke` - mock upstream smoke test
- `pnpm run smoke -- --real` - live extractor smoke test
- `pnpm run local:start|status|stop|publish` - local yt-dlp bridge workflow

## Before finishing work

- Run `pnpm run verify` after meaningful changes.
- Keep docs aligned with the actual extraction flow.
- All changes affect the extractor bridge → yt-dlp flow.
