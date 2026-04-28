import type { WorkerFetcher } from "./runtime-types.ts";

export interface Env {
  ASSETS: WorkerFetcher;
  EXTRACTOR_API_KEY?: string;
  EXTRACTOR_URL: string;
  EXTRACTOR_BEARER_TOKEN?: string;
  EXTRACTOR_VPC?: WorkerFetcher;
  EXTRACTOR_TIMEOUT_MS?: string;
  DOWNLOAD_TOKEN_SECRET: string;
  MAX_BATCH_SIZE?: string;
  MAX_UPSTREAM_CONCURRENCY?: string;
}

export function requireEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return trimmed;
}

export function readIntEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}
