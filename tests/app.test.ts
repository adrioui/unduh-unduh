import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/worker/app.ts";
import type { Env } from "../src/worker/env.ts";
import type { WorkerFetcher } from "../src/worker/runtime-types.ts";

function createEnv(): Env {
  return {
    ASSETS: createAssetFetcher(
      async () => new Response("<!doctype html><title>asset</title>", { status: 200 }),
    ),
    COBALT_API_URL: "https://cobalt.example/",
    DOWNLOAD_TOKEN_SECRET: "test-secret",
    MAX_BATCH_SIZE: "25",
    MAX_UPSTREAM_CONCURRENCY: "2",
  };
}

test("health route reports upstream status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://cobalt.example/") {
      return new Response(
        JSON.stringify({
          cobalt: {
            services: ["instagram", "tiktok"],
            version: "1.2.3",
          },
        }),
        { status: 200 },
      );
    }

    throw new Error("unexpected fetch");
  }) as typeof fetch;

  try {
    const response = await handleRequest(
      new Request("https://app.example/api/health"),
      createEnv(),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; services: string[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.services, ["instagram", "tiktok"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolve route returns normalized results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://cobalt.example/" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          filename: "clip.mp4",
          status: "tunnel",
          url: "https://cobalt.example/tunnel/clip.mp4",
        }),
        { status: 200 },
      );
    }

    if (url === "https://cobalt.example/tunnel/clip.mp4") {
      return new Response("bytes", { status: 200 });
    }

    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const resolve = await handleRequest(
      new Request("https://app.example/api/resolve", {
        body: JSON.stringify({
          urls: ["https://www.tiktok.com/@demo/video/1234567890123456789"],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createEnv(),
    );

    assert.equal(resolve.status, 200);
    const body = (await resolve.json()) as {
      results: Array<{
        items: Array<{ downloadPath: string }>;
        status: string;
      }>;
    };
    assert.equal(body.results[0]?.status, "ready");
    assert.ok(body.results[0]?.items[0]?.downloadPath);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createAssetFetcher(fetchImpl: WorkerFetcher["fetch"]): WorkerFetcher {
  return {
    fetch: fetchImpl,
  };
}
