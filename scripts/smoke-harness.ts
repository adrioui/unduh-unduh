import { createServer } from "node:http";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { handleRequest } from "../src/worker/app.ts";
import type { Env } from "../src/worker/env.ts";
import type { WorkerFetcher } from "../src/worker/runtime-types.ts";

const realMode = process.argv.includes("--real");

const baseEnv = {
  EXTRACTOR_TIMEOUT_MS: "20000",
  DOWNLOAD_TOKEN_SECRET: process.env.DOWNLOAD_TOKEN_SECRET ?? "dev-only-manual-smoke-secret",
  MAX_BATCH_SIZE: "25",
  MAX_UPSTREAM_CONCURRENCY: "3",
} satisfies Omit<Env, "ASSETS" | "EXTRACTOR_URL" | "EXTRACTOR_API_KEY" | "EXTRACTOR_BEARER_TOKEN">;

const upstreamAuth = {
  ...(process.env.EXTRACTOR_API_KEY ? { EXTRACTOR_API_KEY: process.env.EXTRACTOR_API_KEY } : {}),
  ...(process.env.EXTRACTOR_BEARER_TOKEN
    ? { EXTRACTOR_BEARER_TOKEN: process.env.EXTRACTOR_BEARER_TOKEN }
    : {}),
};

if (realMode) {
  const extractorUrl = process.env.EXTRACTOR_URL;
  const tiktokUrl = process.env.SMOKE_TIKTOK_URL;
  const instagramUrl = process.env.SMOKE_INSTAGRAM_URL;

  if (!extractorUrl || !tiktokUrl || !instagramUrl) {
    throw new Error(
      "Real smoke mode requires EXTRACTOR_URL, SMOKE_TIKTOK_URL, and SMOKE_INSTAGRAM_URL.",
    );
  }

  const env: Env = {
    ...baseEnv,
    ASSETS: createAssetFetcher(async () => new Response("ok")),
    EXTRACTOR_URL: extractorUrl,
    ...upstreamAuth,
  };

  await runSmoke(env, [tiktokUrl, instagramUrl]);
  console.log("real smoke harness passed");
} else {
  const server = await startMockExtractor();

  try {
    const env: Env = {
      ...baseEnv,
      ASSETS: createAssetFetcher(async () => new Response("<!doctype html><title>mock</title>")),
      EXTRACTOR_URL: server.url,
      ...upstreamAuth,
    };

    await runSmoke(env, [
      "https://www.tiktok.com/@clipharbor/video/7654321098765432101",
      "https://www.instagram.com/reel/C0FFEE12345/",
    ]);
    console.log("mock smoke harness passed");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.instance.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

async function runSmoke(env: Env, urls: string[]): Promise<void> {
  const health = await handleRequest(new Request("http://local.test/api/health"), env);
  assert.equal(health.status, 200);

  const resolve = await handleRequest(
    new Request("http://local.test/api/resolve", {
      body: JSON.stringify({ urls }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    env,
  );

  assert.equal(resolve.status, 200);
  const body = (await resolve.json()) as {
    results: Array<{
      items: Array<{ downloadPath: string }>;
      status: string;
    }>;
  };

  assert.equal(body.results.length, 2);
  assert.equal(body.results[0]?.status, "ready");
  assert.equal(body.results[1]?.status, "ready");

  const downloadPath = body.results[0]?.items[0]?.downloadPath;
  assert.ok(downloadPath);

  const download = await handleRequest(new Request(`http://local.test${downloadPath}`), env);

  assert.equal(download.status, 200);
  const bytes = await download.arrayBuffer();
  assert.ok(bytes.byteLength > 0);
}

async function startMockExtractor(): Promise<{
  instance: ReturnType<typeof createServer>;
  url: string;
}> {
  const instance = createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400).end("missing url");
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          supportedPlatforms: ["instagram", "tiktok"],
          version: "mock-1.0.0",
        }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/extract") {
      const body = await readBody(request);
      const payload = JSON.parse(body) as { url: string };
      response.writeHead(200, { "content-type": "application/json" });

      if (payload.url.includes("instagram.com")) {
        response.end(
          JSON.stringify({
            filename: "instagram-reel.mp4",
            url: `${serverUrl(instance)}/files/instagram-reel.mp4`,
            type: "video",
          }),
        );
        return;
      }

      response.end(
        JSON.stringify({
          filename: "tiktok-video.mp4",
          url: `${serverUrl(instance)}/files/tiktok-video.mp4`,
          type: "video",
        }),
      );
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/files/")) {
      response.writeHead(200, {
        "content-type": "video/mp4",
      });
      response.end(Buffer.from("mock video bytes"));
      return;
    }

    response.writeHead(404).end("not found");
  });

  await new Promise<void>((resolve) => {
    instance.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    instance,
    url: serverUrl(instance),
  };
}

function serverUrl(instance: ReturnType<typeof createServer>): string {
  const address = instance.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function createAssetFetcher(fetchImpl: WorkerFetcher["fetch"]): WorkerFetcher {
  return {
    fetch: fetchImpl,
  };
}
