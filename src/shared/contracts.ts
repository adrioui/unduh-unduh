export const DOWNLOAD_MODES = ["auto", "audio", "mute"] as const;
export const FILENAME_STYLES = ["basic", "pretty", "classic", "nerdy"] as const;
export const VIDEO_QUALITIES = ["max", "1080", "720", "480", "360", "240", "144"] as const;

export type DownloadMode = (typeof DOWNLOAD_MODES)[number];
export type FilenameStyle = (typeof FILENAME_STYLES)[number];
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];
export type SupportedPlatform = "instagram" | "tiktok";
export type ResolvedItemKind = "video" | "audio" | "photo" | "gif";
export type ResolveStatus = "ready" | "error";

export interface ResolveOptions {
  allowH265: boolean;
  downloadMode: DownloadMode;
  filenameStyle: FilenameStyle;
  tiktokFullAudio: boolean;
  videoQuality: VideoQuality;
}

export interface ResolveRequestBody {
  options?: Partial<ResolveOptions>;
  urls: string[];
}

export interface DownloadItem {
  downloadPath: string;
  filename: string;
  id: string;
  kind: ResolvedItemKind;
  label: string;
  previewUrl?: string;
}

export interface ResolveResult {
  items: DownloadItem[];
  message?: string;
  platform: SupportedPlatform | "unknown";
  sourceUrl: string;
  status: ResolveStatus;
  title: string;
}

export interface ResolveResponseBody {
  generatedAt: string;
  results: ResolveResult[];
}

export interface HealthResponseBody {
  authenticated: boolean;
  message?: string;
  ok: boolean;
  services: string[];
  upstreamUrl: string;
  version?: string;
}

export const DEFAULT_RESOLVE_OPTIONS: ResolveOptions = {
  allowH265: false,
  downloadMode: "auto",
  filenameStyle: "pretty",
  tiktokFullAudio: false,
  videoQuality: "1080",
};

export function normalizeResolveOptions(
  input: Partial<ResolveOptions> | undefined,
): ResolveOptions {
  return {
    allowH265: input?.allowH265 ?? DEFAULT_RESOLVE_OPTIONS.allowH265,
    downloadMode: isOneOf(DOWNLOAD_MODES, input?.downloadMode)
      ? input.downloadMode
      : DEFAULT_RESOLVE_OPTIONS.downloadMode,
    filenameStyle: isOneOf(FILENAME_STYLES, input?.filenameStyle)
      ? input.filenameStyle
      : DEFAULT_RESOLVE_OPTIONS.filenameStyle,
    tiktokFullAudio: input?.tiktokFullAudio ?? DEFAULT_RESOLVE_OPTIONS.tiktokFullAudio,
    videoQuality: isOneOf(VIDEO_QUALITIES, input?.videoQuality)
      ? input.videoQuality
      : DEFAULT_RESOLVE_OPTIONS.videoQuality,
  };
}

function isOneOf<const T extends readonly string[]>(
  values: T,
  input: string | undefined,
): input is T[number] {
  return typeof input === "string" && values.includes(input);
}
