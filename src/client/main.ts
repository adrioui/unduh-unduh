import {
  DEFAULT_RESOLVE_OPTIONS,
  VIDEO_QUALITIES,
  type DownloadItem,
  type HealthResponseBody,
  type ResolveOptions,
  type ResolveResponseBody,
  type ResolveResult,
} from "../shared/contracts.ts";
import { parseUrlList } from "../shared/sources.ts";
import catSvg from "./cat-mascot.svg?raw";
import "./styles.css";

const storageKey = "unduh-unduh.draft";
const downloadConcurrency = 3;

type DownloadPhase = "idle" | "queued" | "downloading" | "done" | "error";
type MascotState = "idle" | "loading" | "success" | "error" | "waiting";

interface DownloadState {
  message?: string;
  phase: DownloadPhase;
}

const mascotMessages: Record<MascotState, string> = {
  idle: "Ready to download",
  loading: "Finding your video...",
  success: "Ready!",
  error: "Something went wrong",
  waiting: "Paste a link to get started",
};

class MascotController {
  private element: HTMLElement;
  private currentState: MascotState = "idle";

  constructor(selector: string) {
    this.element = document.querySelector(selector)!;
    this.setState("waiting");
  }

  setState(state: MascotState): void {
    this.currentState = state;
    this.element.dataset.state = state;

    // Toggle SVG groups
    const groups = this.element.querySelectorAll('g[id^="state-"]');
    groups.forEach((g) => {
      (g as SVGGElement).style.display = g.id === `state-${state}` ? "block" : "none";
    });

    // Update aria-label
    this.element.setAttribute("aria-label", mascotMessages[state]);

    // Update message text
    const msgEl = document.querySelector<HTMLElement>(".mascot-message");
    if (msgEl) {
      msgEl.textContent = mascotMessages[state];
    }
  }

  getState(): MascotState {
    return this.currentState;
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing app root.");
}

app.innerHTML = `
  <main class="stage">
    <!-- Utility nav -->
    <nav class="utility-nav">
      <a href="#how-it-works">How it works</a>
      <a href="#settings">Settings</a>
      <a href="#about">About</a>
    </nav>

    <!-- Cat mascot -->
    <div class="mascot-wrap">
      <div class="cat-mascot" id="cat-mascot" data-state="waiting" aria-hidden="true">
        ${catSvg}
      </div>
    </div>
    <div class="mascot-message" aria-live="polite">${mascotMessages.waiting}</div>

    <!-- Input stage -->
    <div class="input-stage">
      <form id="resolve-form">
        <div class="omnibox">
          <span class="omnibox-icon" aria-hidden="true">↵</span>
          <input
            type="text"
            id="url-input"
            placeholder="Paste a link"
            autocomplete="off"
            aria-label="Video URL"
          />
          <button class="omnibox-clear" id="clear-input" type="button" aria-label="Clear">×</button>
          <button class="omnibox-submit" id="resolve-button" type="submit">Download</button>
        </div>

        <!-- Hidden form controls to preserve options serialization -->
        <select id="video-quality" name="videoQuality" class="hidden"></select>
        <input id="allow-h265" name="allowH265" type="checkbox" class="hidden" />
        <input id="tiktok-full-audio" name="tiktokFullAudio" type="checkbox" class="hidden" />

      </form>
    </div>

    <!-- Switcher chips -->
    <div class="switcher" role="group" aria-label="Download options">
      <button class="switcher-chip" data-option="quality" value="best" type="button">
        Best quality
      </button>
      <button class="switcher-chip" data-option="audio" value="original" type="button">
        Original audio
      </button>
      <button class="switcher-chip" data-option="speed" value="fast" type="button">
        Fast mode
      </button>
    </div>

    <!-- Quick actions -->
    <div class="quick-actions">
      <button class="paste-button" id="paste-button" type="button">
        Paste from clipboard
      </button>

    </div>

    <!-- Inline results -->
    <div class="results-area" id="results-area">
      <div class="results-head">
        <div class="results-summary" id="results-summary"></div>
        <button class="ghost results-download-all" id="download-all" type="button" hidden>
          Download all
        </button>
      </div>
      <div class="results-list" id="results"></div>
    </div>
  </main>

  <footer class="stage-footer">
    <p>Paste links from Instagram or TikTok. No accounts needed.</p>
  </footer>
`;

// Initialize mascot
const mascot = new MascotController("#cat-mascot");

// Get elements
const form = getRequiredElement<HTMLFormElement>("#resolve-form");
const urlInput = getRequiredElement<HTMLInputElement>("#url-input");
const clearInputButton = getRequiredElement<HTMLButtonElement>("#clear-input");
const resolveButton = getRequiredElement<HTMLButtonElement>("#resolve-button");
const pasteButton = getRequiredElement<HTMLButtonElement>("#paste-button");
const downloadAllButton = getRequiredElement<HTMLButtonElement>("#download-all");
// healthDot removed — status rendered in footer instead
const resultsRoot = getRequiredElement<HTMLDivElement>("#results");
const summaryRoot = getRequiredElement<HTMLDivElement>("#results-summary");
const videoQuality = getRequiredElement<HTMLSelectElement>("#video-quality");
const allowH265 = getRequiredElement<HTMLInputElement>("#allow-h265");
const tiktokFullAudio = getRequiredElement<HTMLInputElement>("#tiktok-full-audio");
const switcherChips = document.querySelectorAll<HTMLButtonElement>(".switcher-chip");

let currentResults: ResolveResult[] = [];
const downloadStates = new Map<string, DownloadState>();

hydrateSelect(videoQuality, VIDEO_QUALITIES);
restoreDraft();
refreshHealth();
renderResults([]);

// ---- Switcher chip logic ----
for (const chip of switcherChips) {
  chip.addEventListener("click", () => {
    // Deactivate all chips
    for (const c of switcherChips) {
      c.classList.remove("active");
    }
    chip.classList.add("active");

    const option = chip.dataset.option;

    // Map chip selections to form options
    if (option === "quality") {
      // Best quality: max resolution, allow H265
      videoQuality.value = "max";
      allowH265.checked = true;
      tiktokFullAudio.checked = false;
    } else if (option === "audio") {
      // Original audio: full audio, default quality
      videoQuality.value = DEFAULT_RESOLVE_OPTIONS.videoQuality;
      allowH265.checked = false;
      tiktokFullAudio.checked = true;
    } else if (option === "speed") {
      // Fast mode: lower quality, no H265
      videoQuality.value = "720";
      allowH265.checked = false;
      tiktokFullAudio.checked = false;
    }

    persistDraft();
  });
}

// ---- Clear input button visibility ----
function updateClearButton(): void {
  if (urlInput.value.length > 0) {
    clearInputButton.classList.add("visible");
  } else {
    clearInputButton.classList.remove("visible");
  }
}

urlInput.addEventListener("input", updateClearButton);
updateClearButton();

clearInputButton.addEventListener("click", () => {
  urlInput.value = "";
  updateClearButton();
  urlInput.focus();
  currentResults = [];
  downloadStates.clear();
  renderResults([]);
  mascot.setState("waiting");
  persistDraft();
});

// ---- Paste button ----
pasteButton.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text;
      updateClearButton();
      persistDraft();
      urlInput.focus();
    }
  } catch {
    // Clipboard access denied — fallback: focus the input so user can Ctrl+V
    urlInput.focus();
  }
});

// ---- Event listeners ----
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await resolveBatch();
});

downloadAllButton.addEventListener("click", async () => {
  await queueDownloads(currentResults.flatMap((result) => result.items));
});

for (const field of [urlInput, videoQuality, allowH265, tiktokFullAudio]) {
  field.addEventListener("change", persistDraft);
  field.addEventListener("input", persistDraft);
}

// ---- Core logic ----

async function resolveBatch(): Promise<void> {
  const urls = parseUrlList(urlInput.value);
  if (!urls.length) {
    summaryRoot.textContent = "Paste at least one link to get started.";
    resultsRoot.replaceChildren();
    mascot.setState("waiting");
    return;
  }

  setBusy(true);
  mascot.setState("loading");
  summaryRoot.textContent = "Loading...";

  try {
    const payload = {
      options: readOptions(),
      urls,
    };

    const response = await fetch("/api/resolve", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
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

    downloadStates.clear();
    currentResults = data.results;
    renderResults(currentResults);
    mascot.setState("success");
  } catch (error) {
    downloadStates.clear();
    currentResults = [];
    resultsRoot.replaceChildren();
    summaryRoot.textContent =
      error instanceof Error ? error.message : "Something went wrong. Please try again.";
    mascot.setState("error");
  } finally {
    setBusy(false);
  }
}

async function refreshHealth(): Promise<void> {
  try {
    const response = await fetch("/api/health");
    const health = (await response.json()) as HealthResponseBody;
    renderHealth(health);
  } catch (error) {
    renderHealth({
      authenticated: false,
      message: error instanceof Error ? error.message : "Unknown connectivity failure.",
      ok: false,
      services: [],
      upstreamUrl: "Unavailable",
    });
  }
}

function renderHealth(health: HealthResponseBody): void {
  // Update footer subtitle with server status instead of masthead dot
  const footer = document.querySelector<HTMLElement>(".stage-footer p");
  if (footer) {
    const baseText = "Paste links from Instagram or TikTok. No accounts needed.";
    if (!health.ok) {
      footer.textContent = `${baseText} (Server unreachable)`;
      footer.style.color = "var(--danger)";
    } else {
      footer.textContent = baseText;
      footer.style.color = "";
    }
  }
}

function renderResults(results: ResolveResult[]): void {
  resultsRoot.replaceChildren();
  updateBulkDownloadButton(results);

  if (!results.length) {
    summaryRoot.textContent = "";

    if (!urlInput.value.trim()) {
      summaryRoot.textContent = "";
    }
    return;
  }

  const items = results.flatMap((result) => result.items).length;
  const completed = results
    .flatMap((result) => result.items)
    .filter((item) => getDownloadState(item.id).phase === "done").length;
  const failed = results
    .flatMap((result) => result.items)
    .filter((item) => getDownloadState(item.id).phase === "error").length;
  const progressSuffix = [
    completed ? `${completed} saved` : null,
    failed ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  summaryRoot.textContent = `${items} ${items === 1 ? "video" : "videos"} found${progressSuffix ? ` — ${progressSuffix}` : ""}`;

  for (const result of results) {
    resultsRoot.append(createResultGroup(result));
  }
}

function createResultGroup(result: ResolveResult): HTMLElement {
  const group = document.createElement("div");
  group.className = "result-group";
  group.dataset.state = result.status;

  const heading = document.createElement("div");
  heading.className = "result-group-title";
  heading.textContent = result.title;

  group.append(heading);

  if (result.message) {
    const message = document.createElement("p");
    message.className = "result-group-message";
    message.textContent = result.message;
    group.append(message);
  }

  if (!result.items.length) {
    return group;
  }

  // Add a "Download all" row for multiple items
  if (result.items.length > 1) {
    const bulkRow = document.createElement("div");
    bulkRow.className = "download-row";

    const bulkBtn = document.createElement("button");
    bulkBtn.className = "ghost";
    bulkBtn.type = "button";
    bulkBtn.textContent = `Download all (${result.items.length})`;
    bulkBtn.addEventListener("click", () => {
      void queueDownloads(result.items);
    });

    bulkRow.append(bulkBtn);
    group.append(bulkRow);
  }

  for (const item of result.items) {
    group.append(createDownloadRow(item));
  }

  return group;
}

function createDownloadRow(item: DownloadItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "download-row";
  const state = getDownloadState(item.id);

  const label = document.createElement("span");
  label.className = "download-row-label";
  label.textContent = item.label;

  const actions = document.createElement("div");
  actions.className = "download-row-actions";

  const statePill = document.createElement("span");
  statePill.className = "state-pill";
  statePill.dataset.phase = state.phase;
  statePill.textContent = downloadPhaseLabel(state.phase);
  actions.append(statePill);

  const button = document.createElement("button");
  button.className = "primary";
  button.type = "button";
  button.textContent = downloadButtonLabel(state.phase);
  button.disabled = state.phase === "queued" || state.phase === "downloading";
  button.addEventListener("click", () => {
    void queueDownloads([item]);
  });

  actions.append(button);
  row.append(label, actions);
  return row;
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
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 30_000);
}

function readOptions(): ResolveOptions {
  return {
    allowH265: allowH265.checked,
    downloadMode: DEFAULT_RESOLVE_OPTIONS.downloadMode,
    filenameStyle: DEFAULT_RESOLVE_OPTIONS.filenameStyle,
    tiktokFullAudio: tiktokFullAudio.checked,
    videoQuality: videoQuality.value as ResolveOptions["videoQuality"],
  };
}

function applyOptions(options: ResolveOptions): void {
  allowH265.checked = options.allowH265;
  tiktokFullAudio.checked = options.tiktokFullAudio;
  videoQuality.value = options.videoQuality;

  // Sync switcher chip active state based on options
  syncSwitcherChip(options);
}

function syncSwitcherChip(options: ResolveOptions): void {
  // Determine which chip should be active (if options match a preset)
  let activeOption: "quality" | "audio" | "speed" | null = null;

  if (options.tiktokFullAudio) {
    activeOption = "audio";
  } else if (options.videoQuality === "max" && options.allowH265) {
    activeOption = "quality";
  } else if (!options.allowH265 && options.videoQuality === "720") {
    activeOption = "speed";
  }

  for (const chip of switcherChips) {
    chip.classList.toggle("active", activeOption !== null && chip.dataset.option === activeOption);
  }
}

function persistDraft(): void {
  const payload = {
    options: readOptions(),
    urls: urlInput.value,
  };

  localStorage.setItem(storageKey, JSON.stringify(payload));
}

function restoreDraft(): void {
  applyOptions(DEFAULT_RESOLVE_OPTIONS);

  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      options?: Partial<ResolveOptions>;
      urls?: string;
    };
    applyOptions({
      ...DEFAULT_RESOLVE_OPTIONS,
      ...parsed.options,
    });
    urlInput.value = parsed.urls ?? "";
    updateClearButton();
  } catch {
    localStorage.removeItem(storageKey);
  }
}

function hydrateSelect(select: HTMLSelectElement, values: readonly string[]): void {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "max" ? "max available" : `${value}p`;
    select.append(option);
  }
}

function setBusy(isBusy: boolean): void {
  resolveButton.disabled = isBusy;
  resolveButton.textContent = isBusy ? "Loading..." : "Download";
}

function updateBulkDownloadButton(results: ResolveResult[]): void {
  const items = results.flatMap((result) => result.items);
  const active = items.filter((item) => {
    const phase = getDownloadState(item.id).phase;
    return phase === "queued" || phase === "downloading";
  }).length;

  if (!items.length) {
    downloadAllButton.hidden = true;
    downloadAllButton.disabled = true;
    downloadAllButton.textContent = "Download all";
    return;
  }

  downloadAllButton.hidden = false;

  if (active > 0) {
    downloadAllButton.disabled = true;
    downloadAllButton.textContent = "Downloading...";
    return;
  }

  downloadAllButton.disabled = false;
  downloadAllButton.textContent = `Download all (${items.length})`;
}

function getRequiredElement<TElement extends Element>(selector: string): TElement {
  const element = document.querySelector<TElement>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

async function queueDownloads(items: DownloadItem[]): Promise<void> {
  const queue = items.filter((item) => {
    const phase = getDownloadState(item.id).phase;
    return phase !== "queued" && phase !== "downloading";
  });

  if (!queue.length) {
    return;
  }

  for (const item of queue) {
    setDownloadState(item.id, { phase: "queued" });
  }
  renderResults(currentResults);

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
  renderResults(currentResults);

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

  renderResults(currentResults);
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

function setDownloadState(id: string, state: DownloadState): void {
  downloadStates.set(id, state);
}

function getDownloadState(id: string): DownloadState {
  return downloadStates.get(id) ?? { phase: "idle" };
}

function downloadPhaseLabel(phase: DownloadPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting";
    case "downloading":
      return "Downloading";
    case "done":
      return "Done";
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
      return "Download";
    case "error":
      return "Retry";
    default:
      return "Download";
  }
}
