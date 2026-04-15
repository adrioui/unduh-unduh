/**
 * Local storage persistence for draft state.
 */

import { DEFAULT_RESOLVE_OPTIONS, type ResolveOptions } from "../shared/contracts.ts";
import { getState, setState } from "./state.ts";

const storageKey = "unduh-unduh.draft";

interface DraftData {
  options?: Partial<ResolveOptions>;
  urls?: string;
}

export function persistDraft(): void {
  const { options, urls } = getState();
  localStorage.setItem(storageKey, JSON.stringify({ options, urls }));
}

export function restoreDraft(): void {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    setState({
      options: { ...DEFAULT_RESOLVE_OPTIONS },
      urls: "",
    });
    return;
  }

  try {
    const parsed = JSON.parse(raw) as DraftData;
    setState({
      options: { ...DEFAULT_RESOLVE_OPTIONS, ...parsed.options },
      urls: parsed.urls ?? "",
    });
  } catch {
    localStorage.removeItem(storageKey);
  }
}
