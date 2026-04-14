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
import "./styles.css";

const storageKey = "clip-harbor.draft";
const downloadConcurrency = 3;

type DownloadPhase = "idle" | "queued" | "downloading" | "done" | "error";

interface DownloadState {
  message?: string;
  phase: DownloadPhase;
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing app root.");
}

app.innerHTML = `
  <main class="shell">
    <div class="masthead">
      <span class="status-dot" id="health-dot"></span>
      <strong>Clip Harbor</strong>
    </div>

    <section class="hero">
      <h1>Download videos</h1>
      <p class="lede">Paste links to download.</p>
    </section>

    <section class="panel composer">
      <form id="resolve-form">
        <div class="panel-header">
          <div>
            <h2>Links</h2>
          </div>
          <div class="toolbar">
            <label class="file-picker">
              <input id="import-file" accept=".txt,.json" type="file" />
              <span>Import</span>
            </label>
            <button class="ghost" id="clear-form" type="button">Clear</button>
          </div>
        </div>

        <label class="stack">
          <textarea
            id="url-input"
            name="urls"
            placeholder="Paste links"
            rows="8"
          ></textarea>
        </label>

        <details class="options-disclosure">
          <summary>Options</summary>
          <div class="options-grid">
            <label class="stack">
              <span>Quality</span>
              <select id="video-quality" name="videoQuality"></select>
            </label>

            <label class="toggle">
              <input id="allow-h265" name="allowH265" type="checkbox" />
              <span>Highest quality</span>
            </label>

            <label class="toggle">
              <input id="tiktok-full-audio" name="tiktokFullAudio" type="checkbox" />
              <span>Original audio</span>
            </label>
          </div>
        </details>

        <div class="actions">
          <button class="primary" id="resolve-button" type="submit">Download</button>
        </div>
      </form>
    </section>

    <section class="panel results-panel">
      <div class="panel-header">
        <div>
          <h2>Videos</h2>
        </div>
        <button class="ghost" id="download-all" type="button">Download all</button>
      </div>
      <div class="summary" id="results-summary">Paste links above to get started.</div>
      <div class="results-grid" id="results"></div>
    </section>
  </main>
`;

const form = getRequiredElement<HTMLFormElement>("#resolve-form");
const urlInput = getRequiredElement<HTMLTextAreaElement>("#url-input");
const importFileInput = getRequiredElement<HTMLInputElement>("#import-file");
const clearButton = getRequiredElement<HTMLButtonElement>("#clear-form");
const resolveButton = getRequiredElement<HTMLButtonElement>("#resolve-button");
const downloadAllButton = getRequiredElement<HTMLButtonElement>("#download-all");
const healthDot = getRequiredElement<HTMLElement>("#health-dot");
const resultsRoot = getRequiredElement<HTMLDivElement>("#results");
const summaryRoot = getRequiredElement<HTMLDivElement>("#results-summary");
const videoQuality = getRequiredElement<HTMLSelectElement>("#video-quality");
const allowH265 = getRequiredElement<HTMLInputElement>("#allow-h265");
const tiktokFullAudio = getRequiredElement<HTMLInputElement>("#tiktok-full-audio");

let currentResults: ResolveResult[] = [];
const downloadStates = new Map<string, DownloadState>();

hydrateSelect(videoQuality, VIDEO_QUALITIES);
restoreDraft();
void refreshHealth();
renderResults([]);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await resolveBatch();
});

clearButton.addEventListener("click", () => {
  form.reset();
  urlInput.value = "";
  applyOptions(DEFAULT_RESOLVE_OPTIONS);
  persistDraft();
  currentResults = [];
  downloadStates.clear();
  renderResults([]);
});

importFileInput.addEventListener("change", async (event) => {
  const target = event.currentTarget as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();
  const parsed = parseImportedFile(text, file.name);
  urlInput.value = parsed.join("\n");
  persistDraft();
  target.value = "";
});

downloadAllButton.addEventListener("click", async () => {
  await queueDownloads(currentResults.flatMap((result) => result.items));
});

for (const field of [urlInput, videoQuality, allowH265, tiktokFullAudio]) {
  field.addEventListener("change", persistDraft);
  field.addEventListener("input", persistDraft);
}

async function resolveBatch(): Promise<void> {
  const urls = parseUrlList(urlInput.value);
  if (!urls.length) {
    summaryRoot.textContent = "Paste at least one link to get started.";
    resultsRoot.replaceChildren();
    return;
  }

  setBusy(true);
  summaryRoot.textContent = "Loading…";

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
  } catch (error) {
    downloadStates.clear();
    currentResults = [];
    resultsRoot.replaceChildren();
    summaryRoot.textContent =
      error instanceof Error ? error.message : "Something went wrong. Please try again.";
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
  healthDot.dataset.state = health.ok ? "ok" : "error";
  healthDot.title = health.ok ? "" : health.message || "Can't connect";
}

function renderResults(results: ResolveResult[]): void {
  resultsRoot.replaceChildren();
  updateBulkDownloadButton(results);

  if (!results.length) {
    summaryRoot.textContent = "Paste links above to get started.";
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
    resultsRoot.append(createResultCard(result));
  }
}

function createResultCard(result: ResolveResult): HTMLElement {
  const article = document.createElement("article");
  article.className = "result-card";
  article.dataset.state = result.status;

  const heading = document.createElement("h3");
  heading.textContent = result.title;
  article.append(heading);

  if (result.message) {
    const message = document.createElement("p");
    message.className = "message";
    message.textContent = result.message;
    article.append(message);
  }

  if (!result.items.length) {
    return article;
  }

  const list = document.createElement("div");
  list.className = "item-list";

  for (const item of result.items) {
    list.append(createDownloadCard(item));
  }

  article.append(list);
  return article;
}

function createDownloadCard(item: DownloadItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "download-card";
  const state = getDownloadState(item.id);

  const label = document.createElement("strong");
  label.textContent = item.label;

  const actions = document.createElement("div");
  actions.className = "download-actions";

  const statePill = document.createElement("span");
  statePill.className = "state-pill";
  statePill.dataset.phase = state.phase;
  statePill.textContent = downloadPhaseLabel(state.phase);
  actions.append(statePill);

  const button = document.createElement("button");
  button.className = "primary small";
  button.type = "button";
  button.textContent = downloadButtonLabel(state.phase);
  button.disabled = state.phase === "queued" || state.phase === "downloading";
  button.addEventListener("click", () => {
    void queueDownloads([item]);
  });

  actions.append(button);
  card.append(label, actions);
  return card;
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

function parseImportedFile(contents: string, filename: string): string[] {
  if (filename.endsWith(".json")) {
    const parsed = JSON.parse(contents) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { urls?: unknown }).urls)
    ) {
      return (parsed as { urls: unknown[] }).urls.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }

    throw new Error("JSON imports must be an array of URLs or an object with a urls array.");
  }

  return parseUrlList(contents);
}

function setBusy(isBusy: boolean): void {
  resolveButton.disabled = isBusy;
  resolveButton.textContent = isBusy ? "Loading…" : "Download";
}

function updateBulkDownloadButton(results: ResolveResult[]): void {
  const items = results.flatMap((result) => result.items);
  const active = items.filter((item) => {
    const phase = getDownloadState(item.id).phase;
    return phase === "queued" || phase === "downloading";
  }).length;

  if (!items.length) {
    downloadAllButton.disabled = true;
    downloadAllButton.textContent = "Download all";
    return;
  }

  if (active > 0) {
    downloadAllButton.disabled = true;
    downloadAllButton.textContent = "Downloading…";
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
      return "Waiting…";
    case "downloading":
      return "Downloading…";
    case "done":
      return "Download";
    case "error":
      return "Retry";
    default:
      return "Download";
  }
}
