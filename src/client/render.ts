/**
 * Rendering module - handles DOM updates.
 * Subscribes to state changes and re-renders automatically.
 */

import { render } from "lit-html";
import { appTemplate } from "./templates/index.ts";
import { autoGrowTextarea } from "./handlers/index.ts";
import { subscribe } from "./state.ts";

function getOrThrowAppRoot(): HTMLDivElement {
  const el = document.querySelector<HTMLDivElement>("#app");
  if (!el) throw new Error("Missing app root.");
  return el;
}

export function renderApp(): void {
  render(appTemplate(), getOrThrowAppRoot());
  requestAnimationFrame(autoGrowTextarea);
}

/** Initialize the render loop - subscribes to state changes */
export function initRenderer(): void {
  // Subscribe to state changes and re-render
  subscribe(() => {
    renderApp();
  });
}
