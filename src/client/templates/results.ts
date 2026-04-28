/**
 * Results area component templates.
 */

import { html } from "lit-html";
import { map } from "lit-html/directives/map.js";
import type { DownloadItem, ResolveResult } from "../../shared/contracts.ts";
import { getDownloadState } from "../state.ts";
import type { DownloadPhase } from "../types.ts";
import {
  handleCopyCaption,
  handleDownloadClick,
  handleDownloadAllClick,
} from "../handlers/index.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function downloadPhaseLabel(phase: DownloadPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting";
    case "downloading":
      return "Downloading";
    case "done":
      return "Started";
    case "error":
      return "Retry";
    default:
      return "Ready";
  }
}

function downloadButtonLabel(phase: DownloadPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting...";
    case "downloading":
      return "Downloading...";
    case "done":
      return "Download again";
    case "error":
      return "Retry";
    default:
      return "Download";
  }
}

interface ResultsStats {
  completed: number;
  failed: number;
  hasActive: boolean;
  items: DownloadItem[];
}

function collectResultsStats(results: ResolveResult[]): ResultsStats {
  const stats: ResultsStats = { completed: 0, failed: 0, hasActive: false, items: [] };

  for (const result of results) {
    for (const item of result.items) {
      stats.items.push(item);
      const phase = getDownloadState(item.id).phase;
      if (phase === "done") stats.completed += 1;
      else if (phase === "error") stats.failed += 1;
      else if (phase === "queued" || phase === "downloading") stats.hasActive = true;
    }
  }

  return stats;
}

function resultsSummaryText(stats: ResultsStats): string {
  const { completed, failed, items } = stats;
  if (!items.length) return "";

  const progressParts = [
    completed ? `${completed} started` : null,
    failed ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${items.length} ${items.length === 1 ? "video" : "videos"} found${progressParts ? ` — ${progressParts}` : ""}`;
}

// ─── Sub-templates ──────────────────────────────────────────────────────────

function downloadRowTemplate(item: DownloadItem) {
  const ds = getDownloadState(item.id);
  const isBusy = ds.phase === "queued" || ds.phase === "downloading";

  return html`
    <div class="download-row">
      <span class="download-row-label">${item.label}</span>
      <div class="download-row-actions">
        <span class="state-pill" data-phase=${ds.phase}>${downloadPhaseLabel(ds.phase)}</span>
        <button
          class="primary"
          type="button"
          ?disabled=${isBusy}
          @click=${handleDownloadClick(item)}
        >
          ${downloadButtonLabel(ds.phase)}
        </button>
      </div>
    </div>
  `;
}

function resultGroupTemplate(result: ResolveResult) {
  return html`
    <div class="result-group" data-state=${result.status}>
      ${result.caption
        ? html`
            <div class="result-group-header">
              <div class="result-group-title">${result.title}</div>
              <button
                class="ghost copy-caption-btn"
                type="button"
                @click=${(e: Event) => handleCopyCaption(e, result.caption!)}
              >
                Copy caption
              </button>
            </div>
          `
        : html`<div class="result-group-title">${result.title}</div>`}
      ${result.message ? html`<p class="result-group-message">${result.message}</p>` : ""}
      ${result.items.length > 1
        ? html`
            <div class="download-row">
              <button class="ghost" type="button" @click=${handleDownloadAllClick(result.items)}>
                Download all (${result.items.length})
              </button>
            </div>
          `
        : ""}
      ${map(result.items, (item) => downloadRowTemplate(item))}
    </div>
  `;
}

// ─── Main results area template ─────────────────────────────────────────────

export function resultsAreaTemplate(results: ResolveResult[]) {
  const stats = collectResultsStats(results);

  return html`
    <div class="results-area" id="results-area">
      <div class="results-head">
        <div class="results-summary" id="results-summary">${resultsSummaryText(stats)}</div>
        <button
          class="ghost results-download-all"
          id="download-all"
          type="button"
          ?hidden=${stats.items.length === 0}
          ?disabled=${stats.hasActive}
          @click=${handleDownloadAllClick(stats.items)}
        >
          ${stats.hasActive ? "Downloading..." : `Download all (${stats.items.length})`}
        </button>
      </div>
      <div class="results-list" id="results">
        ${map(results, (result) => resultGroupTemplate(result))}
      </div>
    </div>
  `;
}
