// Client for the configured yt-dlp extraction upstream.
// In free local mode, `scripts/local-origin-server.ts` provides a small bridge backed by yt-dlp.
import type { DownloadItem, ResolveResult, ResolvedItemKind } from "../shared/contracts.ts";
import { inferPlatform, sourceLabel } from "../shared/sources.ts";
import { humanizeFilename, sanitizeFilename } from "../shared/strings.ts";
import type { Env } from "./env.ts";
import { issueDownloadToken } from "./token.ts";

// ── New clean API types ──

interface ExtractorHealthResponse {
  ok: boolean;
  version?: string;
  supportedPlatforms?: string[];
}

interface ExtractorResolveResponse {
  url: string;
  filename: string;
  caption?: string;
  directUrl?: string;
  httpHeaders?: Record<string, string>;
  thumbnailUrl?: string;
  type?: string;
}

interface ExtractorErrorResponse {
  error: string;
}

// ── Upstream info ──

export async function fetchUpstreamInfo(env: Env): Promise<{
  authenticated: boolean;
  services: string[];
  version?: string;
}> {
  const upstreamResponse = await fetchUpstream(env, new URL("/", env.EXTRACTOR_URL), {
    headers: buildUpstreamHeaders(env),
  });

  if (!upstreamResponse.ok) {
    throw new Error(`Upstream info request failed with ${upstreamResponse.status}`);
  }

  const payload = (await upstreamResponse.json()) as ExtractorHealthResponse;
  const result: {
    authenticated: boolean;
    services: string[];
    version?: string;
  } = {
    authenticated: hasUpstreamAuth(env),
    services: payload.supportedPlatforms ?? [],
  };
  if (payload.version) {
    result.version = payload.version;
  }

  return result;
}

// ── Source resolution ──

export async function resolveSource(env: Env, sourceUrl: string): Promise<ResolveResult> {
  const timeoutMs = Number(env.EXTRACTOR_TIMEOUT_MS ?? "90000");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchUpstream(env, new URL("/extract", env.EXTRACTOR_URL), {
      body: JSON.stringify({ url: sourceUrl }),
      headers: {
        ...buildUpstreamHeaders(env),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorMessage: string;
      try {
        const errorPayload = (await response.json()) as ExtractorErrorResponse;
        errorMessage = errorPayload.error ?? `Upstream rejected the request (${response.status}).`;
      } catch {
        errorMessage = `Upstream rejected the request (${response.status}).`;
      }
      return createErrorResult(sourceUrl, errorMessage);
    }

    const payload = (await response.json()) as ExtractorResolveResponse;

    const kind = mapTypeToKind(payload.type);
    const filename = sanitizeFilename(payload.filename);
    const title = filename ? humanizeFilename(filename) : sourceLabel(inferPlatform(sourceUrl));

    const items: DownloadItem[] = [
      {
        downloadPath: await buildDownloadPath(
          env,
          filename,
          toDownloadUrl(env, payload),
          sanitizeRemoteHeaders(payload.httpHeaders),
        ),
        filename,
        id: crypto.randomUUID(),
        kind,
        label: kind === "video" ? "Video file" : `${capitalize(kind)} file`,
        ...(payload.thumbnailUrl ? { previewUrl: payload.thumbnailUrl } : {}),
      },
    ];

    return {
      ...(payload.caption?.trim() ? { caption: payload.caption.trim() } : {}),
      items,
      platform: inferPlatform(sourceUrl),
      sourceUrl,
      status: "ready",
      title,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Upstream timed out after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : "Unknown upstream failure.";

    return createErrorResult(sourceUrl, message);
  } finally {
    clearTimeout(timer);
  }
}

// ── Download helpers ──

function toDownloadUrl(env: Env, payload: ExtractorResolveResponse): string {
  if (payload.directUrl && isSafeDirectUrl(payload.directUrl, payload.httpHeaders)) {
    return payload.directUrl;
  }

  try {
    const parsed = new URL(payload.url);
    if (parsed.pathname.startsWith("/download")) {
      const base = new URL(env.EXTRACTOR_URL);
      const basePath = base.pathname.replace(/\/+$/u, "");
      return `${base.origin}${basePath}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // ignore parse errors, fall back to original URL
  }
  return payload.url;
}

export async function buildUpstreamDownloadRequestInit(
  env: Env,
  remoteUrl: string,
  remoteHeaders?: Record<string, string>,
): Promise<RequestInit> {
  const headers = new Headers(sanitizeRemoteHeaders(remoteHeaders));

  // Only send extractor credentials back to the configured extractor. Direct
  // CDN downloads must never receive the private extractor API key.
  if (isConfiguredExtractorUrl(env, remoteUrl)) {
    for (const [name, value] of Object.entries(buildUpstreamHeaders(env))) {
      headers.set(name, value);
    }
  }

  return {
    headers,
    redirect: "follow",
  };
}

export function hasUpstreamAuth(env: Env): boolean {
  return Boolean(env.EXTRACTOR_API_KEY || env.EXTRACTOR_BEARER_TOKEN);
}

export function fetchUpstream(
  env: Env,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (env.EXTRACTOR_VPC && isConfiguredExtractorUrl(env, input)) {
    return env.EXTRACTOR_VPC.fetch(input, init);
  }

  return fetch(input, init);
}

function sanitizeRemoteHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const allowed: Record<string, string> = {
    accept: "Accept",
    "accept-language": "Accept-Language",
    referer: "Referer",
    "user-agent": "User-Agent",
  };
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const canonical = allowed[name.trim().toLowerCase()];
    if (canonical && !/[\r\n]/u.test(value) && value.length <= 512) {
      sanitized[canonical] = value;
    }
  }

  return Object.keys(sanitized).length ? sanitized : undefined;
}

function isSafeDirectUrl(url: string, headers: Record<string, string> | undefined): boolean {
  try {
    if (new URL(url).protocol !== "https:") {
      return false;
    }
  } catch {
    return false;
  }

  if (!headers) {
    return true;
  }

  return !Object.keys(headers).some((name) => {
    const lower = name.trim().toLowerCase();
    return lower === "authorization" || lower === "cookie" || lower === "proxy-authorization";
  });
}

function isConfiguredExtractorUrl(env: Env, input: RequestInfo | URL): boolean {
  try {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    return target.origin === new URL(env.EXTRACTOR_URL).origin;
  } catch {
    return false;
  }
}

// ── Internals ──

function buildUpstreamHeaders(env: Env): Record<string, string> {
  if (env.EXTRACTOR_API_KEY) {
    return {
      Authorization: `Api-Key ${env.EXTRACTOR_API_KEY}`,
    };
  }

  if (env.EXTRACTOR_BEARER_TOKEN) {
    return {
      Authorization: `Bearer ${env.EXTRACTOR_BEARER_TOKEN}`,
    };
  }

  return {};
}

function mapTypeToKind(type: string | undefined): ResolvedItemKind {
  switch (type) {
    case "audio":
      return "audio";
    case "photo":
      return "photo";
    case "gif":
      return "gif";
    case "video":
    default:
      return "video";
  }
}

async function buildDownloadPath(
  env: Env,
  filename: string,
  remoteUrl: string,
  remoteHeaders?: Record<string, string>,
): Promise<string> {
  const token = await issueDownloadToken(env.DOWNLOAD_TOKEN_SECRET, {
    expiresAt: Date.now() + 1000 * 60 * 15,
    filename,
    ...(remoteHeaders ? { remoteHeaders } : {}),
    remoteUrl,
  });
  return `/api/download?token=${encodeURIComponent(token)}`;
}

function createErrorResult(sourceUrl: string, message: string): ResolveResult {
  return {
    items: [],
    message,
    platform: inferPlatform(sourceUrl),
    sourceUrl,
    status: "error",
    title: sourceLabel(inferPlatform(sourceUrl)),
  };
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
