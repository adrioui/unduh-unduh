import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/worker/app.ts";
import type { Env } from "../src/worker/env.ts";
import type { WorkerFetcher } from "../src/worker/runtime-types.ts";
import { issueDownloadToken } from "../src/worker/token.ts";

function createEnv(): Env {
  return {
    ASSETS: createAssetFetcher(
      async () => new Response("<!doctype html><title>asset</title>", { status: 200 }),
    ),
    EXTRACTOR_URL: "https://extractor.example/",
    DOWNLOAD_TOKEN_SECRET: "test-secret",
    MAX_BATCH_SIZE: "25",
    MAX_UPSTREAM_CONCURRENCY: "2",
  };
}

test("health route reports upstream status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://extractor.example/") {
      return new Response(
        JSON.stringify({
          ok: true,
          supportedPlatforms: ["instagram", "tiktok"],
          version: "1.2.3",
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
    if (url === "https://extractor.example/extract" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          filename: "clip.mp4",
          url: "https://extractor.example/download/clip.mp4",
          type: "video",
        }),
        { status: 200 },
      );
    }

    if (url === "https://extractor.example/download/clip.mp4") {
      return new Response("bytes", { status: 200 });
    }

    throw new Error(`unexpected fetch ${url} ${init?.method ?? ""}`);
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
        caption?: string;
        items: Array<{ downloadPath: string }>;
        status: string;
      }>;
    };
    assert.equal(body.results[0]?.status, "ready");
    assert.ok(body.results[0]?.items[0]?.downloadPath);
    assert.equal(body.results[0]?.caption, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolve route deduplicates repeated URLs before calling extractor", async () => {
  const originalFetch = globalThis.fetch;
  let extractCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://extractor.example/extract" && init?.method === "POST") {
      extractCalls += 1;
      return new Response(
        JSON.stringify({
          filename: "clip.mp4",
          type: "video",
          url: "https://extractor.example/download/clip.mp4",
        }),
        { status: 200 },
      );
    }

    throw new Error(`unexpected fetch ${url} ${init?.method ?? ""}`);
  }) as typeof fetch;

  try {
    const source = "https://www.tiktok.com/@demo/video/1234567890123456789";
    const resolve = await handleRequest(
      new Request("https://app.example/api/resolve", {
        body: JSON.stringify({ urls: [source, source] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createEnv(),
    );

    assert.equal(resolve.status, 200);
    const body = (await resolve.json()) as { results: Array<{ status: string }> };
    assert.equal(extractCalls, 1);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0]?.status, "ready");
    assert.equal(body.results[1]?.status, "ready");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolve route passes caption from extractor", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://extractor.example/extract" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          caption: "Check out this amazing video! #fun #viral",
          filename: "tiktok-video-789.mp4",
          type: "video",
          url: "https://extractor.example/download/tiktok-video-789.mp4",
        }),
        { status: 200 },
      );
    }

    throw new Error(`unexpected fetch ${url} ${init?.method ?? ""}`);
  }) as typeof fetch;

  try {
    const resolve = await handleRequest(
      new Request("https://app.example/api/resolve", {
        body: JSON.stringify({
          urls: ["https://www.tiktok.com/@user/video/1234567890"],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      createEnv(),
    );

    assert.equal(resolve.status, 200);
    const body = (await resolve.json()) as {
      results: Array<{ caption?: string; status: string }>;
    };
    assert.equal(body.results[0]?.status, "ready");
    assert.equal(body.results[0]?.caption, "Check out this amazing video! #fun #viral");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download route rejects missing token", async () => {
  const response = await handleRequest(
    new Request("https://app.example/api/download"),
    createEnv(),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: string };
  assert.equal(body.error, "Missing download token.");
});

test("download route rejects invalid token", async () => {
  const response = await handleRequest(
    new Request("https://app.example/api/download?token=invalid.token.here"),
    createEnv(),
  );
  assert.equal(response.status, 401);
  const body = (await response.json()) as { error?: string };
  assert.equal(body.error, "Invalid or tampered download token.");
});

test("download route rejects expired token", async () => {
  const expiredToken = await issueDownloadToken("test-secret", {
    expiresAt: Date.now() - 1000,
    filename: "clip.mp4",
    remoteUrl: "https://extractor.example/download/clip.mp4",
  });

  const response = await handleRequest(
    new Request(`https://app.example/api/download?token=${encodeURIComponent(expiredToken)}`),
    createEnv(),
  );
  assert.equal(response.status, 410);
  const body = (await response.json()) as { error?: string };
  assert.equal(body.error, "This download link has expired. Resolve the source again.");
});

test("download route rejects unsafe remote URLs", async () => {
  const token = await issueDownloadToken("test-secret", {
    expiresAt: Date.now() + 60_000,
    filename: "clip.mp4",
    remoteUrl: "http://evil.com/clip.mp4",
  });

  const response = await handleRequest(
    new Request(`https://app.example/api/download?token=${encodeURIComponent(token)}`),
    createEnv(),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: string };
  assert.equal(body.error, "Refusing to proxy an unsafe upstream URL.");
});

test("download route proxies upstream stream", async () => {
  const originalFetch = globalThis.fetch;
  const largeBody = new Uint8Array(2_000_000); // 2 MB
  for (let offset = 0; offset < largeBody.length; offset += 65536) {
    const chunk = largeBody.subarray(offset, offset + 65536);
    crypto.getRandomValues(chunk);
  }

  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://extractor.example/download/clip.mp4") {
      return new Response(largeBody, {
        headers: {
          "content-length": String(largeBody.length),
          "content-type": "video/mp4",
          "x-custom-header": "should-be-stripped",
        },
        status: 200,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const token = await issueDownloadToken("test-secret", {
      expiresAt: Date.now() + 60_000,
      filename: "clip.mp4",
      remoteUrl: "https://extractor.example/download/clip.mp4",
    });

    const response = await handleRequest(
      new Request(`https://app.example/api/download?token=${encodeURIComponent(token)}`),
      createEnv(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(response.headers.get("content-disposition")?.includes("clip.mp4"));
    assert.equal(response.headers.get("x-custom-header"), null);
    assert.equal(response.headers.get("content-length"), null);

    const received = new Uint8Array(await response.arrayBuffer());
    assert.equal(received.length, largeBody.length);
    assert.deepEqual(received, largeBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download route proxies direct CDN URLs without leaking extractor auth", async () => {
  const originalFetch = globalThis.fetch;
  let seenAuthorization: string | null = null;
  let seenUserAgent: string | null = null;

  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://cdn.example/clip.mp4") {
      const headers = new Headers(init?.headers);
      seenAuthorization = headers.get("authorization");
      seenUserAgent = headers.get("user-agent");
      return new Response("cdn-bytes", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const env = { ...createEnv(), EXTRACTOR_API_KEY: "private-key" };
    const token = await issueDownloadToken("test-secret", {
      expiresAt: Date.now() + 60_000,
      filename: "clip.mp4",
      remoteHeaders: {
        Cookie: "must-not-be-used",
        "User-Agent": "yt-dlp-test-agent",
      },
      remoteUrl: "https://cdn.example/clip.mp4",
    });

    const response = await handleRequest(
      new Request(`https://app.example/api/download?token=${encodeURIComponent(token)}`),
      env,
    );

    assert.equal(response.status, 200);
    assert.equal(seenAuthorization, null);
    assert.equal(seenUserAgent, "yt-dlp-test-agent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download route infers content-type from filename", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://extractor.example/download/audio.mp3") {
      return new Response("audio-bytes", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const token = await issueDownloadToken("test-secret", {
      expiresAt: Date.now() + 60_000,
      filename: "audio.mp3",
      remoteUrl: "https://extractor.example/download/audio.mp3",
    });

    const response = await handleRequest(
      new Request(`https://app.example/api/download?token=${encodeURIComponent(token)}`),
      createEnv(),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download route surfaces upstream errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://extractor.example/download/broken.mp4") {
      return new Response("upstream failure", { status: 503 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const token = await issueDownloadToken("test-secret", {
      expiresAt: Date.now() + 60_000,
      filename: "broken.mp4",
      remoteUrl: "https://extractor.example/download/broken.mp4",
    });

    const response = await handleRequest(
      new Request(`https://app.example/api/download?token=${encodeURIComponent(token)}`),
      createEnv(),
    );

    assert.equal(response.status, 503);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "upstream failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download route handles missing upstream body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://extractor.example/download/empty.mp4") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const token = await issueDownloadToken("test-secret", {
      expiresAt: Date.now() + 60_000,
      filename: "empty.mp4",
      remoteUrl: "https://extractor.example/download/empty.mp4",
    });

    const response = await handleRequest(
      new Request(`https://app.example/api/download?token=${encodeURIComponent(token)}`),
      createEnv(),
    );

    assert.equal(response.status, 502);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Upstream download request failed.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download route allows http localhost remote URLs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "http://127.0.0.1:9010/download/clip.mp4") {
      return new Response("local-bytes", { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const token = await issueDownloadToken("test-secret", {
      expiresAt: Date.now() + 60_000,
      filename: "clip.mp4",
      remoteUrl: "http://127.0.0.1:9010/download/clip.mp4",
    });

    const response = await handleRequest(
      new Request(`https://app.example/api/download?token=${encodeURIComponent(token)}`),
      createEnv(),
    );

    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createAssetFetcher(fetchImpl: WorkerFetcher["fetch"]): WorkerFetcher {
  return {
    fetch: fetchImpl,
  };
}
