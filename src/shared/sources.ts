import type { SupportedPlatform } from "./contracts.ts";

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const TIKTOK_HOSTS = new Set([
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

const ALLOWED_INSTAGRAM_PREFIXES = ["/reel/", "/reels/", "/p/"];
const TIKTOK_VIDEO_MARKERS = ["/video/", "/photo/"];

export function parseUrlList(input: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const raw of input.split(/[\n,]+/u)) {
    const normalized = normalizeSourceUrl(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    urls.push(normalized);
  }

  return urls;
}

export function normalizeSourceUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const withScheme =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : trimmed.startsWith("www.")
        ? `https://${trimmed}`
        : null;

  if (!withScheme) {
    return null;
  }

  try {
    const url = new URL(withScheme);
    url.hash = "";

    for (const key of Array.from(url.searchParams.keys())) {
      if (key.startsWith("utm_") || key === "igsh") {
        url.searchParams.delete(key);
      }
    }

    const normalizedPath = url.pathname.replace(/\/+$/u, "") || "/";
    url.pathname = normalizedPath;
    return url.toString();
  } catch {
    return null;
  }
}

export function inferPlatform(input: string): SupportedPlatform | "unknown" {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();

    if (
      INSTAGRAM_HOSTS.has(hostname) &&
      ALLOWED_INSTAGRAM_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ) {
      return "instagram";
    }

    if (
      TIKTOK_HOSTS.has(hostname) &&
      (TIKTOK_VIDEO_MARKERS.some((marker) => pathname.includes(marker)) ||
        hostname === "vm.tiktok.com" ||
        hostname === "vt.tiktok.com")
    ) {
      return "tiktok";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

export function isSupportedSourceUrl(input: string): boolean {
  return inferPlatform(input) !== "unknown";
}

export function sourceLabel(platform: SupportedPlatform | "unknown"): string {
  switch (platform) {
    case "instagram":
      return "Instagram Reel";
    case "tiktok":
      return "TikTok";
    default:
      return "Unknown source";
  }
}
