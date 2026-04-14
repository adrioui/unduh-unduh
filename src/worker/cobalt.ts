// Client for the configured Cobalt-compatible extraction upstream.
// In normal deployments that upstream is Cobalt itself.
// In free local mode, `scripts/local-origin-server.ts` provides a small bridge backed by yt-dlp.
import type {
  DownloadItem,
  ResolveOptions,
  ResolveResult,
  ResolvedItemKind,
} from "../shared/contracts.ts";
import { humanizeFilename, sanitizeFilename } from "../shared/strings.ts";
import { inferPlatform, sourceLabel } from "../shared/sources.ts";
import type { Env } from "./env.ts";
import { issueDownloadToken } from "./token.ts";

interface CobaltRedirectResponse {
  filename: string;
  status: "redirect" | "tunnel";
  url: string;
}

interface CobaltPickerItem {
  thumb?: string;
  type: ResolvedItemKind;
  url: string;
}

interface CobaltPickerResponse {
  audio?: string;
  audioFilename?: string;
  picker: CobaltPickerItem[];
  status: "picker";
}

interface CobaltLocalProcessingResponse {
  output: {
    filename: string;
  };
  service: string;
  status: "local-processing";
  tunnel: string[];
  type: string;
}

interface CobaltErrorResponse {
  error: {
    code: string;
  };
  status: "error";
}

type CobaltResponse =
  | CobaltRedirectResponse
  | CobaltPickerResponse
  | CobaltLocalProcessingResponse
  | CobaltErrorResponse;

interface CobaltInfoResponse {
  cobalt?: {
    services?: string[];
    version?: string;
  };
}

export async function fetchCobaltInfo(env: Env): Promise<{
  authenticated: boolean;
  services: string[];
  version?: string;
}> {
  const upstreamResponse = await fetch(new URL("/", env.COBALT_API_URL), {
    headers: buildUpstreamHeaders(env),
  });

  if (!upstreamResponse.ok) {
    throw new Error(`Upstream info request failed with ${upstreamResponse.status}`);
  }

  const payload = (await upstreamResponse.json()) as CobaltInfoResponse;
  const result: {
    authenticated: boolean;
    services: string[];
    version?: string;
  } = {
    authenticated: hasUpstreamAuth(env),
    services: payload.cobalt?.services ?? [],
  };
  if (payload.cobalt?.version) {
    result.version = payload.cobalt.version;
  }

  return result;
}

export async function resolveSource(
  env: Env,
  sourceUrl: string,
  options: ResolveOptions,
): Promise<ResolveResult> {
  const timeoutMs = Number(env.COBALT_TIMEOUT_MS ?? "20000");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL("/", env.COBALT_API_URL), {
      body: JSON.stringify({
        allowH265: options.allowH265,
        alwaysProxy: true,
        downloadMode: options.downloadMode,
        filenameStyle: options.filenameStyle,
        localProcessing: "disabled",
        tiktokFullAudio: options.tiktokFullAudio,
        url: sourceUrl,
        videoQuality: options.videoQuality,
      }),
      headers: {
        ...buildUpstreamHeaders(env),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: controller.signal,
    });

    const payload = (await response.json()) as CobaltResponse;

    if (!response.ok) {
      return createErrorResult(sourceUrl, `Upstream rejected the request (${response.status}).`);
    }

    if (payload.status === "error") {
      return createErrorResult(
        sourceUrl,
        `Upstream could not resolve this URL (${payload.error.code}).`,
      );
    }

    if (payload.status === "local-processing") {
      return createErrorResult(
        sourceUrl,
        "The upstream extractor requested local post-processing, which this Cloudflare deployment intentionally does not perform.",
      );
    }

    const items =
      payload.status === "picker"
        ? await signPickerItems(env, sourceUrl, payload)
        : await signSingleItem(env, payload);

    const title = items[0]?.filename
      ? humanizeFilename(items[0].filename)
      : sourceLabel(inferPlatform(sourceUrl));

    return {
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

export async function buildDownloadRequestInit(env: Env, remoteUrl: string): Promise<RequestInit> {
  const remote = new URL(remoteUrl);
  const upstreamOrigin = new URL(env.COBALT_API_URL).origin;

  if (remote.origin === upstreamOrigin) {
    return {
      headers: buildUpstreamHeaders(env),
      redirect: "follow",
    };
  }

  return {
    redirect: "follow",
  };
}

export function hasUpstreamAuth(env: Env): boolean {
  return Boolean(env.COBALT_API_KEY || env.COBALT_BEARER_TOKEN);
}

function buildUpstreamHeaders(env: Env): HeadersInit {
  if (env.COBALT_API_KEY) {
    return {
      Authorization: `Api-Key ${env.COBALT_API_KEY}`,
    };
  }

  if (env.COBALT_BEARER_TOKEN) {
    return {
      Authorization: `Bearer ${env.COBALT_BEARER_TOKEN}`,
    };
  }

  return {};
}

async function signSingleItem(env: Env, payload: CobaltRedirectResponse): Promise<DownloadItem[]> {
  return [
    {
      downloadPath: await buildDownloadPath(env, payload.filename, payload.url),
      filename: sanitizeFilename(payload.filename),
      id: crypto.randomUUID(),
      kind: "video",
      label: payload.status === "redirect" ? "Video file" : "Tunneled video",
    },
  ];
}

async function signPickerItems(
  env: Env,
  sourceUrl: string,
  payload: CobaltPickerResponse,
): Promise<DownloadItem[]> {
  const platform = inferPlatform(sourceUrl);
  const items = await Promise.all(
    payload.picker.map(async (item, index) => {
      const result: DownloadItem = {
        downloadPath: await buildDownloadPath(
          env,
          buildPickerFilename(platform, item.type, index + 1),
          item.url,
        ),
        filename: buildPickerFilename(platform, item.type, index + 1),
        id: crypto.randomUUID(),
        kind: item.type,
        label: `${capitalize(item.type)} ${index + 1}`,
      };

      if (item.thumb) {
        result.previewUrl = item.thumb;
      }

      return result;
    }),
  );

  if (payload.audio) {
    items.push({
      downloadPath: await buildDownloadPath(
        env,
        sanitizeFilename(payload.audioFilename ?? `${platform}-audio.mp3`),
        payload.audio,
      ),
      filename: sanitizeFilename(payload.audioFilename ?? `${platform}-audio.mp3`),
      id: crypto.randomUUID(),
      kind: "audio",
      label: "Original audio",
    });
  }

  return items;
}

async function buildDownloadPath(env: Env, filename: string, remoteUrl: string): Promise<string> {
  const token = await issueDownloadToken(env.DOWNLOAD_TOKEN_SECRET, {
    expiresAt: Date.now() + 1000 * 60 * 15,
    filename,
    remoteUrl,
  });
  return `/api/download?token=${encodeURIComponent(token)}`;
}

function buildPickerFilename(
  platform: ResolveResult["platform"],
  type: ResolvedItemKind,
  position: number,
): string {
  const extensionByType: Record<ResolvedItemKind, string> = {
    audio: "mp3",
    gif: "gif",
    photo: "jpg",
    video: "mp4",
  };

  return sanitizeFilename(
    `${platform === "unknown" ? "media" : platform}-${type}-${String(position).padStart(2, "0")}.${extensionByType[type]}`,
  );
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
