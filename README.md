# Clip Harbor

Clip Harbor is a Cloudflare-deployable bulk downloader for public Instagram Reels and TikTok videos. The app is written in TypeScript, ships a Worker API plus a static front end, and deliberately reuses the existing Cobalt extraction API instead of embedding a fragile scraper in the repo.

## Why this shape

- Cloudflare Workers do not provide functional `child_process` support, so a `yt-dlp`-style subprocess cannot run inside the Worker runtime.
- Cobalt already exposes an API for Instagram posts/reels and TikTok, and its own docs recommend running your own instance instead of consuming the public hosted API from other projects.
- This repo keeps the Cloudflare side clean: the Worker validates input, fans out batch requests, signs download links, and proxies the final file stream only when the user actually downloads something.

## Stack

- `vite-plus` for build/check workflow
- `pnpm` for package management
- Cloudflare Workers + static assets
- A separately hosted Cobalt API instance

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

## Install

```bash
pnpm install
```

## Commands

```bash
pnpm check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm dev
pnpm smoke
pnpm origin:start
pnpm origin:publish
pnpm origin:status
pnpm origin:stop
```

## Local smoke flow

The app expects a Cobalt API. For local integration testing, bring up your own instance first. Cobalt documents Docker-based self-hosting and local Node execution in its repo:

- Cobalt run guide: <https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md>
- Cobalt API docs: <https://github.com/imputnet/cobalt/blob/main/docs/api.md>

Example local sequence:

```bash
git clone --depth=1 https://github.com/imputnet/cobalt /tmp/cobalt
docker build -t clip-harbor-cobalt /tmp/cobalt
docker run --rm -p 9000:9000 -e API_URL=http://127.0.0.1:9000/ clip-harbor-cobalt
```

Then in another shell:

```bash
cp .dev.vars.example .dev.vars
pnpm smoke -- --real
```

For real smoke mode, set these environment variables first:

- `COBALT_API_URL`
- `SMOKE_TIKTOK_URL`
- `SMOKE_INSTAGRAM_URL`

Without `--real`, `pnpm smoke` runs against the repo’s mock Cobalt harness.

## Deploy to Cloudflare

```bash
pnpm build
pnpm deploy
```

This deploys the Worker and the static assets bundle. The extraction API remains external by design; point `COBALT_API_URL` at your own Cobalt deployment. If you want the extractor itself on Cloudflare, run Cobalt in a separate container-compatible lane and use its public URL here.

## Free Local-Origin Mode

If you do not want to pay for a remote Cobalt host, this repo can use the current machine as the origin:

1. `pnpm origin:publish`
2. keep this machine running
3. if the machine or tunnel restarts, run `pnpm origin:publish` again

What that command does:

- starts a local TypeScript origin service on `127.0.0.1:9010`
- uses the machine's installed `yt-dlp` for real Instagram/TikTok extraction
- generates a private API key for the local origin
- starts a Cloudflare Quick Tunnel from this machine
- updates Worker secrets to point at the current tunnel URL
- deploys the Worker to Cloudflare

Important limitation:

- Quick Tunnel URLs are temporary and change whenever the tunnel restarts. This is the free fallback. For a stable hostname, you need a Cloudflare-managed domain and a named tunnel.

Runtime state and generated secrets are stored under `.runtime/local-origin/` and ignored by git.

## Notes

- Only public TikTok and Instagram content is supported.
- Download links are short-lived and HMAC-signed to avoid exposing an open proxy endpoint.
- If the upstream extractor asks for local post-processing, the Worker rejects the item instead of pretending it can process media inside the edge runtime.
