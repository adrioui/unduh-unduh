# Unduh Unduh

Unduh Unduh is a Cloudflare-deployable downloader for public Instagram Reels and TikTok videos.

## How it works

The Worker talks to a local extractor bridge that shells out to `yt-dlp` for URL resolution.

```text
Browser -> Cloudflare Worker -> extractor bridge -> yt-dlp
                             -> signed /api/download -> proxied file stream
```

The Worker itself never runs `yt-dlp`.

## Why it is shaped this way

- Cloudflare Workers do not support `child_process`, so `yt-dlp` cannot run inside Worker code.
- The bridge exposes a clean HTTP API that the Worker calls via `EXTRACTOR_URL`.
- Download links are signed so the Worker does not become an open proxy.
- The bridge extracts captions from yt-dlp's `description` field and returns them to the UI.

## Stack

- TypeScript
- Cloudflare Workers + static assets
- `vite-plus`
- `pnpm`
- `yt-dlp` via a local bridge

## Repo layout

- `src/client/` — browser UI
- `src/worker/` — Worker API, extractor client, token handling
- `src/shared/` — shared contracts and helpers
- `scripts/local-origin-server.ts` — yt-dlp bridge
- `scripts/*.sh` — bridge lifecycle and publish helpers
- `tests/` — Worker tests and smoke harness

## Install

```bash
pnpm install
```

## Environment

Copy `.dev.vars.example` to `.dev.vars` for local Wrangler work:

```bash
cp .dev.vars.example .dev.vars
```

Required values:

- `EXTRACTOR_URL`
- `DOWNLOAD_TOKEN_SECRET`

Optional values:

- `EXTRACTOR_API_KEY`
- `EXTRACTOR_BEARER_TOKEN`
- `EXTRACTOR_TIMEOUT_MS`
- `MAX_BATCH_SIZE`
- `MAX_UPSTREAM_CONCURRENCY`

`EXTRACTOR_URL` is the extractor bridge the Worker should call.

## Commands

```bash
pnpm run check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run dev
pnpm run smoke
pnpm run verify
```

## Local bridge with yt-dlp

```bash
pnpm run local:publish
```

That command:

- starts the local bridge on `127.0.0.1:9010`
- uses the machine's installed `yt-dlp` for extraction
- generates a private API key for the bridge
- starts a Cloudflare Quick Tunnel
- updates Worker secrets to point at the tunnel
- deploys the Worker

Important limitations:

- the machine must stay online
- Quick Tunnel URLs are temporary
- if the bridge or tunnel restarts, run `pnpm run local:publish` again

Runtime state and generated local secrets live under `.runtime/local-origin/` and are ignored by git.

## Local bridge commands

```bash
pnpm run local:start
pnpm run local:status
pnpm run local:stop
pnpm run local:publish
```

## Smoke tests

### Mock smoke test

```bash
pnpm run smoke
```

This uses the repo's mock extractor harness.

### Real smoke test

Point `EXTRACTOR_URL` at a real extractor bridge, then:

```bash
EXTRACTOR_URL=http://your-extractor:port/ \
SMOKE_TIKTOK_URL='https://www.tiktok.com/@example/video/123' \
SMOKE_INSTAGRAM_URL='https://www.instagram.com/reel/example/' \
pnpm run smoke -- --real
```

## Deploy to Cloudflare

```bash
pnpm run build
pnpm run deploy
```

This deploys the Worker and the static assets bundle.
The extractor stays external by design.

## Notes

- Only public TikTok and Instagram content is supported.
- Run `pnpm run verify` before pushing changes.
