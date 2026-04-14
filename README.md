# Unduh Unduh

Unduh Unduh is a Cloudflare-deployable downloader for public Instagram Reels and TikTok videos.

## Which extractor does it use?

**Both, but not in the same place:**

- **Hosted / normal mode:** the Worker talks to a **Cobalt-compatible HTTP API**.
- **Free local fallback:** the Worker talks to the repo's **local bridge**, and that bridge uses the machine's installed **`yt-dlp`**.

The Worker itself never runs `yt-dlp`.

## Architecture

### Hosted mode

```text
Browser -> Cloudflare Worker -> Cobalt API -> media URL
                             -> signed /api/download -> proxied file stream
```

Use this when you already run Cobalt somewhere reachable by the Worker.

### Local fallback mode

```text
Browser -> Cloudflare Worker -> Quick Tunnel -> local bridge -> yt-dlp
                             -> signed /api/download -> proxied file stream
```

Use this when you do not want to pay for a separate hosted Cobalt instance.

## Why it is shaped this way

- Cloudflare Workers do not support `child_process`, so `yt-dlp` cannot run inside Worker code.
- Cobalt already exposes an extractor over HTTP, which fits the Worker runtime well.
- The local fallback keeps the same HTTP contract by exposing a small Cobalt-compatible bridge backed by `yt-dlp`.
- Download links are signed so the Worker does not become an open proxy.

## Stack

- TypeScript
- Cloudflare Workers + static assets
- `vite-plus`
- `pnpm`
- Cobalt-compatible upstream API
- Optional local `yt-dlp` bridge for the free fallback path

## Repo layout

- `src/client/` — browser UI
- `src/worker/` — Worker API, extractor client, token handling
- `src/shared/` — shared contracts and helpers
- `scripts/local-origin-server.ts` — local Cobalt-compatible bridge backed by `yt-dlp`
- `scripts/*.sh` — local bridge lifecycle and publish helpers
- `tests/` — Worker tests and smoke harness support

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

- `COBALT_API_URL`
- `DOWNLOAD_TOKEN_SECRET`

Optional values:

- `COBALT_API_KEY`
- `COBALT_BEARER_TOKEN`
- `COBALT_TIMEOUT_MS`
- `MAX_BATCH_SIZE`
- `MAX_UPSTREAM_CONCURRENCY`

`COBALT_API_URL` always means “the extractor upstream the Worker should call.”
In normal deployments that is Cobalt. In local fallback mode, `local:publish` temporarily points it at the repo's local bridge.

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

Preferred local fallback commands:

```bash
pnpm run local:start
pnpm run local:status
pnpm run local:stop
pnpm run local:publish
```

Legacy aliases still work:

```bash
pnpm run origin:start
pnpm run origin:status
pnpm run origin:stop
pnpm run origin:publish
```

## Local smoke flow

### Mock smoke flow

```bash
pnpm run smoke
```

This uses the repo's mock extractor harness.

### Real smoke flow against Cobalt

Bring up your own Cobalt instance first. Cobalt docs:

- Run guide: <https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md>
- API docs: <https://github.com/imputnet/cobalt/blob/main/docs/api.md>

Example:

```bash
git clone --depth=1 https://github.com/imputnet/cobalt /tmp/cobalt
docker build -t unduh-unduh-cobalt /tmp/cobalt
docker run --rm -p 9000:9000 -e API_URL=http://127.0.0.1:9000/ unduh-unduh-cobalt
```

Then in another shell:

```bash
cp .dev.vars.example .dev.vars
COBALT_API_URL=http://127.0.0.1:9000/ \
SMOKE_TIKTOK_URL='https://www.tiktok.com/@example/video/123' \
SMOKE_INSTAGRAM_URL='https://www.instagram.com/reel/example/' \
pnpm run smoke -- --real
```

## Free local fallback with yt-dlp

If you do not want to host Cobalt, you can use this machine as the extractor.

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

## Deploy to Cloudflare

```bash
pnpm run build
pnpm run deploy
```

This deploys the Worker and the static assets bundle.
The extractor stays external by design.

## Notes

- Only public TikTok and Instagram content is supported.
- The Worker rejects upstream responses that require local post-processing.
- Run `pnpm run verify` before pushing changes.
