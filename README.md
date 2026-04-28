# Unduh Unduh

Unduh Unduh is a Cloudflare-deployable downloader for public Instagram Reels and TikTok videos.

## How it works

The Worker talks to a lightweight Go extractor bridge that shells out to `yt-dlp` for URL resolution.

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
- Repeated resolve requests are deduplicated in the Worker and served from a short-lived bridge source cache when possible, avoiding extra `yt-dlp` subprocesses on small hosts.
- The bridge ties fallback downloads to client cancellation, kills timed-out `yt-dlp` process groups, disables transparent gzip decoding for media streams, ignores host-level yt-dlp config, caps metadata JSON size, and asks yt-dlp to skip comments/cache work.
- When yt-dlp returns a safe direct HTTPS media URL, the Worker proxies that CDN URL directly so the VPS only performs extraction; downloads fall back through the bridge when private headers/cookies are required.
- Worker download failures only read a small error prefix and abort upstream fetches when clients disconnect, avoiding wasted memory and bandwidth.

## Stack

- TypeScript
- Cloudflare Workers + static assets
- `vite-plus`
- `lit-html` for the browser UI (declarative rendering, no full framework)
- `pnpm`
- `yt-dlp` via a local bridge

## Repo layout

- `src/client/` — browser UI (lit-html templates with reactive state)
- `src/worker/` — Worker API, extractor client, token handling
- `src/shared/` — shared contracts and helpers
- `extractor/` — lightweight Go yt-dlp bridge
- `scripts/local-origin-server.ts` — legacy TypeScript yt-dlp bridge
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
- `EXTRACTOR_TIMEOUT_MS` (default: `90000`)
- `MAX_BATCH_SIZE`
- `MAX_UPSTREAM_CONCURRENCY` (default: `1` for tiny VPS stability)

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

- builds and starts the lightweight Go bridge on `127.0.0.1:9010`
- caps the Go runtime heap by default (`GO_MEMORY_LIMIT_MB=96`) while leaving memory for `yt-dlp`
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

Useful extractor tuning knobs for small hosts:

- `MAX_CONCURRENCY` / `MAX_JOBS` — concurrent `yt-dlp` jobs (default `1`)
- `BUSY_WAIT_SECONDS` — wait briefly for a free job slot before returning busy (default `15`)
- `MAX_CACHE_ENTRIES` — cap short-lived download IDs and source-cache entries (default `64`)
- `GO_MEMORY_LIMIT_MB` — soft Go runtime memory cap (default `96`)
- `YTDLP_TIMEOUT_SECONDS` — extraction timeout (default `90`)
- `MAX_YTDLP_JSON_BYTES` — cap extraction metadata output to protect tiny hosts from unexpectedly huge responses (default `4194304`)
- `YTDLP_PATH` / `YTDLP_VERSION` — optional pinned binary path/version for faster health checks and predictable subprocess lookup

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
