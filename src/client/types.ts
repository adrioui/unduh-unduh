/**
 * Client-side types for the UI layer.
 * Separated from shared contracts to keep client concerns isolated.
 */

import type {
  DownloadItem,
  ResolveOptions,
  ResolveResult,
  HealthResponseBody,
} from "../shared/contracts.ts";

// ─── Download state ─────────────────────────────────────────────────────────

export type DownloadPhase = "idle" | "queued" | "downloading" | "done" | "error";
export type MascotState = "idle" | "loading" | "success" | "error" | "waiting";

export interface DownloadState {
  message?: string;
  phase: DownloadPhase;
}

// ─── App state ──────────────────────────────────────────────────────────────

export interface AppState {
  downloadStates: Map<string, DownloadState>;
  health: HealthResponseBody | null;
  isBusy: boolean;
  isInputFocused: boolean;
  mascotState: MascotState;
  options: ResolveOptions;
  results: ResolveResult[];
  urls: string;
}

// ─── Store types ────────────────────────────────────────────────────────────

export type StateListener = (state: AppState) => void;
export type StateUpdater = Partial<AppState> | ((state: AppState) => Partial<AppState>);

// Re-export shared types for convenience
export type { DownloadItem, ResolveOptions, ResolveResult, HealthResponseBody };
