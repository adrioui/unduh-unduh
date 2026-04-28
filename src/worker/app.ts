import { mapWithConcurrency } from "../shared/async.ts";
import {
  type HealthResponseBody,
  type ResolveRequestBody,
  type ResolveResponseBody,
} from "../shared/contracts.ts";
import { inferPlatform, isSupportedSourceUrl, normalizeSourceUrl } from "../shared/sources.ts";
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
  const concurrency = readIntEnv(env.MAX_UPSTREAM_CONCURRENCY, 1, 1, 10);
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

  const uniqueUrls = [...new Set(normalizedUrls)];
  const uniqueResults = await mapWithConcurrency(uniqueUrls, concurrency, async (sourceUrl) =>
    resolveSource(env, sourceUrl),
  );
  const resultsByUrl = new Map(uniqueResults.map((result) => [result.sourceUrl, result]));
  const results = normalizedUrls.map(
    (sourceUrl) =>
      resultsByUrl.get(sourceUrl) ?? {
        items: [],
        message: "Unable to resolve this URL.",
        platform: inferPlatform(sourceUrl),
        sourceUrl,
        status: "error" as const,
        title: sourceUrl,
      },
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

  const downloadInit = await buildUpstreamDownloadRequestInit(
    env,
    remoteUrl,
    payload.remoteHeaders,
  );
  downloadInit.signal = request.signal;
  const upstream = await fetchUpstream(env, remoteUrl, downloadInit);

  if (!upstream.ok || !upstream.body) {
    const excerpt = upstream.body ? await readResponsePrefix(upstream, 200) : "";
    return errorResponse(
      upstream.ok ? 502 : upstream.status,
      excerpt || "Upstream download request failed.",
    );
  }

  const headers = cleanDownloadHeaders(upstream.headers, payload.filename);

  return new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

async function readResponsePrefix(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader || maxBytes <= 0) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remaining = maxBytes - received;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function cleanDownloadHeaders(upstreamHeaders: Headers, filename: string): Headers {
  const headers = new Headers();

  // Only forward safe, necessary headers. Strip hop-by-hop and size-related
  // headers that can interfere with streaming or become stale after proxying.
  const allowList = new Set(["last-modified", "etag"]);

  for (const [name, value] of upstreamHeaders) {
    if (allowList.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  // Always infer content-type from filename; ignore upstream content-type
  // because runtimes may inject text/plain for string bodies.
  headers.set("content-type", inferContentType(filename));

  headers.set("cache-control", "no-store");
  headers.set("content-disposition", buildContentDisposition(sanitizeFilename(filename)));

  return headers;
}

function inferContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
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
