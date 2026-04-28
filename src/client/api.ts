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
  for (const item of items) {
    const phase = getDownloadState(item.id).phase;
    if (phase === "queued" || phase === "downloading") continue;

    setDownloadState(item.id, { phase: "downloading" });
    triggerDownload(item);
    setDownloadState(item.id, { phase: "done" });
  }
}

function triggerDownload(item: DownloadItem): void {
  const anchor = document.createElement("a");
  anchor.href = item.downloadPath;
  anchor.rel = "noreferrer";
  anchor.download = item.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
