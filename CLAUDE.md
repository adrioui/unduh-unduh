# CLAUDE.md

## What this repo is

Unduh Unduh is a Cloudflare Worker app for downloading public Instagram and TikTok media.
The Worker validates inputs, asks an extractor for downloadable media URLs, signs short-lived download links, and only proxies the final file when the user actually downloads it.

## Extraction modes

There are two valid upstream modes. Keep them distinct.

### 1. Default / hosted mode

- Flow: `Worker -> Cobalt-compatible HTTP API`
- In normal deployments, `COBALT_API_URL` points at a real Cobalt instance.
- The Worker never runs `yt-dlp` directly.

### 2. Free local fallback

- Flow: `Worker -> local bridge -> yt-dlp`
- `scripts/local-origin-server.ts` exposes the small subset of the Cobalt API that the Worker needs.
- That local bridge is the only place in this repo that shells out to `yt-dlp`.
- `pnpm run local:publish` starts the bridge, opens a Quick Tunnel, updates Worker secrets, and deploys.

## Hard constraints

- Cloudflare Workers cannot run `child_process`, so do not move `yt-dlp` into Worker code.
- Download links must stay short-lived and signed; do not turn `/api/download` into an open proxy.
- If an upstream asks for local post-processing, reject it rather than pretending the Worker can do it.
- Never commit secrets, `.dev.vars`, `.runtime/`, `.wrangler/`, build output, or local machine state.

## Repo map

- `src/client/` — browser UI
- `src/worker/` — Worker routes, upstream client, token handling
- `src/shared/` — request/response contracts and shared helpers
- `scripts/local-origin-server.ts` — local Cobalt-compatible bridge backed by `yt-dlp`
- `scripts/*.sh` — local bridge lifecycle and publish helpers
- `tests/` — unit/integration-style tests for Worker behavior

## Conventions

- Prefer `local:*` script names. `origin:*` exists as legacy aliases.
- Treat `COBALT_API_URL` as “configured extractor upstream URL”, even when local mode points it at the bridge.
- Keep user-facing copy plain and non-technical.
- Prefer small, high-leverage edits over broad churn.
- When architecture changes, update both `README.md` and this file.

## Useful commands

- `pnpm run verify` — full pre-push check
- `pnpm run dev` — local Worker dev server
- `pnpm run smoke` — mock upstream smoke test
- `pnpm run smoke -- --real` — live extractor smoke test
- `pnpm run local:start|status|stop|publish` — local yt-dlp bridge workflow

## Before finishing work

- Run `pnpm run verify` after meaningful changes.
- Keep docs aligned with the actual extraction flow.
- Call out clearly whether a change affects hosted Cobalt mode, local yt-dlp mode, or both.
