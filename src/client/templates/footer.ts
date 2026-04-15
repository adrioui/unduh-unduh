/**
 * Footer component template.
 */

import { html } from "lit-html";
import type { HealthResponseBody } from "../../shared/contracts.ts";

export function footerTemplate(health: HealthResponseBody | null) {
  const baseText = "Paste links from Instagram or TikTok. No accounts needed.";
  const isError = health && !health.ok;

  return html`
    <footer class="stage-footer">
      <p style=${isError ? "color: var(--danger)" : ""}>
        ${isError ? `${baseText} (Server unreachable)` : baseText}
      </p>
    </footer>
  `;
}
