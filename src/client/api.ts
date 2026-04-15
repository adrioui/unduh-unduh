/**
 * API calls for the application.
 * Handles resolution, downloads, and health checks.
 */

import { parseUrlList } from "../shared/sources.ts";
import type { DownloadItem, ResolveResponseBody, HealthResponseBody } from "../shared/contracts.ts";
import {
  getState,
  setState,
  setDownloadState,
  getDownloadState,
  clearDownloadStates,
} from "./state.ts";

const downloadConcurrency = 3;

// ─── Core API functions ─────────────────────────────────────────────────────

export async function resolveBatch(): Promise<void> {
  const state = getState();
  const urls = parseUrlList(state.urls);

  if (!urls.length) {
    setState({ mascotState: "waiting", results: [] });
    return;
  }

  setState({ isBusy: true, mascotState: "loading" });

  try {
    const payload = { options: state.options, urls };
    const response = await fetch("/api/resolve", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const data = (await response.json()) as ResolveResponseBody | { error?: string };
    if (!response.ok || !("results" in data)) {
      throw new Error(
        "error" in data && typeof data.error === "string"
          ? data.error
          : "Something went wrong. Please try again.",
      );
    }

    clearDownloadStates();
    setState({
      results: data.results,
      mascotState: "success",
    });
  } catch (error) {
    clearDownloadStates();
    setState({
      results: [],
      mascotState: "error",
    });
    // Re-render with error in summary
    const summaryEl = document.querySelector<HTMLElement>("#results-summary");
    if (summaryEl) {
      summaryEl.textContent = error instanceof Error ? error.message : "Something went wrong.";
    }
  } finally {
    setState({ isBusy: false });
  }
}

export async function refreshHealth(): Promise<void> {
  try {
    const response = await fetch("/api/health");
    const health = (await response.json()) as HealthResponseBody;
    setState({ health });
  } catch (error) {
    setState({
      health: {
        authenticated: false,
        message: error instanceof Error ? error.message : "Unknown connectivity failure.",
        ok: false,
        services: [],
        upstreamUrl: "Unavailable",
      },
    });
  }
}

export async function queueDownloads(items: DownloadItem[]): Promise<void> {
  const queue = items.filter((item) => {
    const phase = getDownloadState(item.id).phase;
    return phase !== "queued" && phase !== "downloading";
  });

  if (!queue.length) return;

  for (const item of queue) {
    setDownloadState(item.id, { phase: "queued" });
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(downloadConcurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const nextIndex = cursor;
      cursor += 1;
      await performDownload(queue[nextIndex]!);
    }
  });

  await Promise.all(workers);
}

async function performDownload(item: DownloadItem): Promise<void> {
  setDownloadState(item.id, { phase: "downloading" });

  try {
    const response = await fetch(item.downloadPath);
    if (!response.ok) {
      throw new Error(await readDownloadError(response));
    }

    const blob = await response.blob();
    triggerDownload(item, blob);
    setDownloadState(item.id, { phase: "done" });
  } catch (error) {
    setDownloadState(item.id, {
      message: error instanceof Error ? error.message : "Download failed.",
      phase: "error",
    });
  }
}

function triggerDownload(item: DownloadItem, blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.rel = "noreferrer";
  anchor.download = item.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

async function readDownloadError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Download failed with status ${response.status}.`;
  }
  const text = await response.text();
  return text || `Download failed with status ${response.status}.`;
}
