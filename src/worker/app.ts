import { mapWithConcurrency } from "../shared/async.ts";
import {
  type HealthResponseBody,
  type ResolveRequestBody,
  type ResolveResponseBody,
} from "../shared/contracts.ts";
import { isSupportedSourceUrl, normalizeSourceUrl } from "../shared/sources.ts";
import { sanitizeFilename } from "../shared/strings.ts";
import { readIntEnv, requireEnv } from "./env.ts";
import {
  buildUpstreamDownloadRequestInit,
  fetchUpstream,
  fetchUpstreamInfo,
  resolveSource,
} from "./upstream.ts";
import type { Env } from "./env.ts";
import { errorResponse, jsonResponse, methodNotAllowed } from "./http.ts";
import { buildContentDisposition, readDownloadToken } from "./token.ts";

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    requireEnv(env.EXTRACTOR_URL, "EXTRACTOR_URL");
    requireEnv(env.DOWNLOAD_TOKEN_SECRET, "DOWNLOAD_TOKEN_SECRET");
  } catch (error) {
    return errorResponse(
      500,
      error instanceof Error ? error.message : "Missing worker configuration.",
    );
  }

  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    return handleHealth(env);
  }

  if (url.pathname === "/api/resolve") {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }

    return handleResolve(request, env);
  }

  if (url.pathname === "/api/download") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }

    return handleDownload(request, env);
  }

  return env.ASSETS.fetch(request);
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    const info = await fetchUpstreamInfo(env);
    const body: HealthResponseBody = {
      authenticated: info.authenticated,
      ok: true,
      services: info.services,
      upstreamUrl: env.EXTRACTOR_URL,
    };
    if (info.version) {
      body.version = info.version;
    }
    return jsonResponse(body);
  } catch (error) {
    const body: HealthResponseBody = {
      authenticated: Boolean(env.EXTRACTOR_API_KEY || env.EXTRACTOR_BEARER_TOKEN),
      message:
        error instanceof Error
          ? error.message
          : "Unable to connect to the configured extractor upstream.",
      ok: false,
      services: [],
      upstreamUrl: env.EXTRACTOR_URL,
    };
    return jsonResponse(body, 502);
  }
}

async function handleResolve(request: Request, env: Env): Promise<Response> {
  let payload: ResolveRequestBody;

  try {
    payload = (await request.json()) as ResolveRequestBody;
  } catch {
    return errorResponse(400, "Request body must be valid JSON.");
  }

  const maxBatchSize = readIntEnv(env.MAX_BATCH_SIZE, 25, 1, 100);
  const concurrency = readIntEnv(env.MAX_UPSTREAM_CONCURRENCY, 3, 1, 10);
  const normalizedUrls = Array.isArray(payload.urls)
    ? payload.urls
        .map((value) => (typeof value === "string" ? normalizeSourceUrl(value) : null))
        .filter((value): value is string => Boolean(value))
    : [];

  if (!normalizedUrls.length) {
    return errorResponse(400, "Provide at least one valid Instagram Reel or TikTok URL.");
  }

  if (normalizedUrls.length > maxBatchSize) {
    return errorResponse(400, `Batch size exceeds the configured limit of ${maxBatchSize} URLs.`);
  }

  if (normalizedUrls.some((value) => !isSupportedSourceUrl(value))) {
    return errorResponse(
      400,
      "Only public TikTok video links and Instagram Reel/post links are supported.",
    );
  }

  const results = await mapWithConcurrency(normalizedUrls, concurrency, async (sourceUrl) =>
    resolveSource(env, sourceUrl),
  );

  const body: ResolveResponseBody = {
    generatedAt: new Date().toISOString(),
    results,
  };

  return jsonResponse(body);
}

async function handleDownload(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return errorResponse(400, "Missing download token.");
  }

  const payload = await readDownloadToken(env.DOWNLOAD_TOKEN_SECRET, token);
  if (!payload) {
    return errorResponse(401, "Invalid or tampered download token.");
  }

  if (payload.expiresAt < Date.now()) {
    return errorResponse(410, "This download link has expired. Resolve the source again.");
  }

  const remoteUrl = safeRemoteUrl(payload.remoteUrl);
  if (!remoteUrl) {
    return errorResponse(400, "Refusing to proxy an unsafe upstream URL.");
  }

  const upstream = await fetchUpstream(
    env,
    remoteUrl,
    await buildUpstreamDownloadRequestInit(env, remoteUrl),
  );

  if (!upstream.ok || !upstream.body) {
    const excerpt = await upstream.text();
    return errorResponse(
      upstream.status || 502,
      excerpt.slice(0, 200) || "Upstream download request failed.",
    );
  }

  const headers = new Headers(upstream.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-disposition", buildContentDisposition(sanitizeFilename(payload.filename)));

  return new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

function safeRemoteUrl(input: string): string | null {
  try {
    const url = new URL(input);

    if (url.protocol === "https:") {
      return url.toString();
    }

    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      return url.toString();
    }

    return null;
  } catch {
    return null;
  }
}
