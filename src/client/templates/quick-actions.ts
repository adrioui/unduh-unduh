/**
 * Quick actions component template.
 */

import { html } from "lit-html";
import { handlePasteFromClipboard } from "../handlers/index.ts";

export function quickActionsTemplate() {
  return html`
    <div class="quick-actions">
      <button
        class="paste-button"
        id="paste-button"
        type="button"
        @click=${handlePasteFromClipboard}
      >
        Paste from clipboard
      </button>
    </div>
  `;
}
