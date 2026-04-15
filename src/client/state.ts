/**
 * Reactive state store for the application.
 * Provides a simple pub/sub pattern for state changes.
 */

import { DEFAULT_RESOLVE_OPTIONS } from "../shared/contracts.ts";
import type { AppState, StateListener, StateUpdater, DownloadState } from "./types.ts";

// ─── Initial state ──────────────────────────────────────────────────────────

const createState = (): AppState => ({
  downloadStates: new Map(),
  health: null,
  isBusy: false,
  isInputFocused: false,
  mascotState: "waiting",
  options: { ...DEFAULT_RESOLVE_OPTIONS },
  results: [],
  urls: "",
});

// ─── Store implementation ───────────────────────────────────────────────────

class Store {
  private state: AppState = createState();
  private listeners: Set<StateListener> = new Set();

  /** Get current immutable state snapshot */
  getState(): Readonly<AppState> {
    return this.state;
  }

  /** Subscribe to state changes */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Update state with partial or updater function */
  setState(updater: StateUpdater): void {
    const updates = typeof updater === "function" ? updater(this.state) : updater;
    const newState = { ...this.state, ...updates };

    // Check if state actually changed
    if (newState === this.state) return;

    this.state = newState;
    this.notify();
  }

  /** Get mutable download states map for batch updates */
  getDownloadStates(): Map<string, DownloadState> {
    return this.state.downloadStates;
  }

  /** Update download state for a specific item */
  setDownloadState(id: string, ds: DownloadState): void {
    this.state.downloadStates.set(id, ds);
    this.notify();
  }

  /** Clear all download states */
  clearDownloadStates(): void {
    this.state.downloadStates.clear();
    this.notify();
  }

  /** Reset to initial state */
  reset(): void {
    this.state = createState();
    this.notify();
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

// ─── Singleton store instance ───────────────────────────────────────────────

export const store = new Store();

// ─── Convenience helpers ────────────────────────────────────────────────────

export function getState(): Readonly<AppState> {
  return store.getState();
}

export function setState(updater: StateUpdater): void {
  store.setState(updater);
}

export function getDownloadState(id: string): DownloadState {
  return store.getDownloadStates().get(id) ?? { phase: "idle" };
}

export function setDownloadState(id: string, ds: DownloadState): void {
  store.setDownloadState(id, ds);
}

export function clearDownloadStates(): void {
  store.clearDownloadStates();
}

export function subscribe(listener: StateListener): () => void {
  return store.subscribe(listener);
}
