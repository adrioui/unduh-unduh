/**
 * Cat mascot component template.
 */

import { html } from "lit-html";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";
import type { MascotState } from "../types.ts";
import catSvg from "../cat-mascot.svg?raw";

export const mascotMessages: Record<MascotState, string> = {
  idle: "Ready to download",
  loading: "Finding your video...",
  success: "Ready!",
  error: "Something went wrong",
  waiting: "Paste a link to get started",
};

export function mascotTemplate(mascotState: MascotState) {
  return html`
    <div class="mascot-wrap">
      <div
        class="cat-mascot"
        id="cat-mascot"
        data-state=${mascotState}
        aria-hidden="true"
        aria-label=${mascotMessages[mascotState]}
      >
        ${unsafeSVG(catSvg)}
      </div>
    </div>
    <div class="mascot-message" aria-live="polite">${mascotMessages[mascotState]}</div>
  `;
}
