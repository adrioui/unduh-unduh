/**
 * Event handlers for the application.
 * Separated from templates for cleaner organization.
 * Note: State changes trigger re-renders via store subscription.
 */

import { DEFAULT_RESOLVE_OPTIONS } from "../../shared/contracts.ts";
import { getState, setState, clearDownloadStates } from "../state.ts";
import { persistDraft } from "../persistence.ts";
import { resolveBatch, queueDownloads } from "../api.ts";
import type { DownloadItem, MascotState } from "../types.ts";

// ─── Refs (managed externally, set during init) ─────────────────────────────

interface MutableRef<T> {
  value: T | null;
}

let urlInputRef: MutableRef<HTMLTextAreaElement> = { value: null };

export function setUrlInputRef(ref: MutableRef<HTMLTextAreaElement>): void {
  urlInputRef = ref;
}

export function getUrlInputRef(): MutableRef<HTMLTextAreaElement> {
  return urlInputRef;
}

// ─── Auto-grow textarea ─────────────────────────────────────────────────────

export function autoGrowTextarea(): void {
  const el = urlInputRef.value;
  if (!el) return;
  el.style.height = "auto";
  const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 22;
  const maxRows = 8;
  const maxHeight = lineHeight * maxRows;
  const scrollHeight = el.scrollHeight;
  el.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
  el.style.overflowY = scrollHeight > maxHeight ? "auto" : "hidden";
}

// ─── Event handlers ─────────────────────────────────────────────────────────

export function handleSubmit(event: Event): void {
  event.preventDefault();
  void resolveBatch();
}

export function handleUrlInput(event: InputEvent): void {
  const value = (event.target as HTMLTextAreaElement).value;
  setState({ urls: value });
  persistDraft();
  autoGrowTextarea();
}

export function handlePaste(): void {
  setTimeout(() => {
    const el = urlInputRef.value;
    if (el) {
      setState({ urls: el.value });
      persistDraft();
      autoGrowTextarea();
    }
  }, 0);
}

export function handleClearInput(): void {
  clearDownloadStates();
  setState({
    urls: "",
    results: [],
    mascotState: "waiting" as MascotState,
  });
  persistDraft();
  setTimeout(() => urlInputRef.value?.focus(), 0);
}

export async function handlePasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      setState({ urls: text });
      persistDraft();
      setTimeout(() => urlInputRef.value?.focus(), 0);
    }
  } catch {
    urlInputRef.value?.focus();
  }
}

export function handleFocus(): void {
  setState({ isInputFocused: true });
}

export function handleBlur(): void {
  setState({ isInputFocused: false });
}

export function handleChipClick(option: "quality" | "audio" | "speed"): void {
  const state = getState();
  const newOptions = { ...state.options };

  if (option === "quality") {
    newOptions.videoQuality = "max";
    newOptions.allowH265 = true;
    newOptions.tiktokFullAudio = false;
  } else if (option === "audio") {
    newOptions.videoQuality = DEFAULT_RESOLVE_OPTIONS.videoQuality;
    newOptions.allowH265 = false;
    newOptions.tiktokFullAudio = true;
  } else if (option === "speed") {
    newOptions.videoQuality = "720";
    newOptions.allowH265 = false;
    newOptions.tiktokFullAudio = false;
  }

  setState({ options: newOptions });
  persistDraft();
}

export async function handleCopyCaption(event: Event, caption: string): Promise<void> {
  const button = event.target as HTMLButtonElement;
  try {
    await navigator.clipboard.writeText(caption);
    button.textContent = "Copied!";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = "Copy caption";
      button.classList.remove("copied");
    }, 1500);
  } catch {
    button.textContent = "Failed";
    setTimeout(() => {
      button.textContent = "Copy caption";
    }, 1500);
  }
}

export function handleDownloadClick(item: DownloadItem): () => void {
  return () => void queueDownloads([item]);
}

export function handleDownloadAllClick(items: DownloadItem[]): () => void {
  return () => void queueDownloads(items);
}
