/**
 * Omnibox (URL input) component template.
 */

import { html } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { classMap } from "lit-html/directives/class-map.js";
import { map } from "lit-html/directives/map.js";
import { VIDEO_QUALITIES, type ResolveOptions } from "../../shared/contracts.ts";

interface OmniboxProps {
  onRef(element: HTMLTextAreaElement | null): void;
  linkCount: number;
  hasContent: boolean;
  isExpanded: boolean;
  isFocused: boolean;
  isBusy: boolean;
  urls: string;
  options: ResolveOptions;
  onSubmit: (e: Event) => void;
  onInput: (e: InputEvent) => void;
  onFocus: () => void;
  onBlur: () => void;
  onPaste: (e: ClipboardEvent) => void;
  onClear: () => void;
}

export function omniboxTemplate(props: OmniboxProps) {
  const {
    onRef,
    linkCount,
    hasContent,
    isExpanded,
    isFocused,
    isBusy,
    urls,
    options,
    onSubmit,
    onInput,
    onFocus,
    onBlur,
    onPaste,
    onClear,
  } = props;

  return html`
    <div class="input-stage">
      <form id="resolve-form" @submit=${onSubmit}>
        <div class="omnibox ${classMap({ expanded: isExpanded, focused: isFocused })}" id="omnibox">
          <div class="omnibox-top">
            <span class="omnibox-icon" aria-hidden="true">🔗</span>
            <textarea
              id="url-input"
              placeholder="Paste links here..."
              autocomplete="off"
              aria-label="Video URLs"
              rows="2"
              .value=${live(urls)}
              ${onRef}
              @input=${onInput}
              @focus=${onFocus}
              @blur=${onBlur}
              @paste=${onPaste}
            ></textarea>
            <button
              class="omnibox-clear ${classMap({ visible: hasContent })}"
              id="clear-input"
              type="button"
              aria-label="Clear"
              @click=${onClear}
            >
              ×
            </button>
          </div>
          <div class="omnibox-bottom">
            <span class="link-count" ?hidden=${linkCount <= 1}> ${linkCount} links </span>
            <button class="omnibox-submit" id="resolve-button" type="submit" ?disabled=${isBusy}>
              ${isBusy ? "Loading..." : "Download"}
            </button>
          </div>
        </div>

        <!-- Hidden form controls -->
        <select
          id="video-quality"
          name="videoQuality"
          class="hidden"
          .value=${options.videoQuality}
        >
          ${map(
            VIDEO_QUALITIES,
            (v) => html`<option value=${v}>${v === "max" ? "max available" : `${v}p`}</option>`,
          )}
        </select>
        <input
          id="allow-h265"
          name="allowH265"
          type="checkbox"
          class="hidden"
          ?checked=${options.allowH265}
        />
        <input
          id="tiktok-full-audio"
          name="tiktokFullAudio"
          type="checkbox"
          class="hidden"
          ?checked=${options.tiktokFullAudio}
        />
      </form>
    </div>
  `;
}
