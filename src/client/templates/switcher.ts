/**
 * Switcher chips component template.
 */

import { html } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import type { ResolveOptions } from "../../shared/contracts.ts";
import { handleChipClick } from "../handlers/index.ts";

function isChipActive(option: "quality" | "audio" | "speed", opts: ResolveOptions): boolean {
  if (option === "audio" && opts.tiktokFullAudio) return true;
  if (option === "quality" && opts.videoQuality === "max" && opts.allowH265) return true;
  if (option === "speed" && !opts.allowH265 && opts.videoQuality === "720") return true;
  return false;
}

function switcherChipTemplate(
  option: "quality" | "audio" | "speed",
  label: string,
  options: ResolveOptions,
) {
  return html`
    <button
      class="switcher-chip ${classMap({ active: isChipActive(option, options) })}"
      data-option=${option}
      type="button"
      @click=${() => handleChipClick(option)}
    >
      ${label}
    </button>
  `;
}

export function switcherTemplate(options: ResolveOptions) {
  return html`
    <div class="switcher" role="group" aria-label="Download options">
      ${switcherChipTemplate("quality", "Best quality", options)}
      ${switcherChipTemplate("audio", "Original audio", options)}
      ${switcherChipTemplate("speed", "Fast mode", options)}
    </div>
  `;
}
