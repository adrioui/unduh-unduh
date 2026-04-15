/**
 * Application entry point.
 * Initializes state, renders the app, and starts health polling.
 */

import "./styles.css";
import { restoreDraft } from "./persistence.ts";
import { refreshHealth } from "./api.ts";
import { initRenderer } from "./render.ts";

function init(): void {
  // Initialize the render loop (subscribes to state changes)
  initRenderer();

  // Restore draft and start
  restoreDraft();

  // Check server health
  refreshHealth();
}

init();
