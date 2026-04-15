/**
 * Main application template - composes all sub-templates.
 */

import { html } from "lit-html";
import { parseUrlList } from "../../shared/sources.ts";
import { getState } from "../state.ts";
import {
  handleSubmit,
  handleUrlInput,
  handlePaste,
  handleClearInput,
  handleFocus,
  handleBlur,
  setUrlInputRef,
} from "../handlers/index.ts";

import { navTemplate } from "./nav.ts";
import { mascotTemplate } from "./mascot.ts";
import { omniboxTemplate } from "./omnibox.ts";
import { switcherTemplate } from "./switcher.ts";
import { quickActionsTemplate } from "./quick-actions.ts";
import { resultsAreaTemplate } from "./results.ts";
import { footerTemplate } from "./footer.ts";

// ─── Refs ───────────────────────────────────────────────────────────────────

// Plain mutable ref object - lit-html's ref directive will set .value
const urlInputRef = { value: null as HTMLTextAreaElement | null };

// Register ref with handlers
setUrlInputRef(urlInputRef);

// ─── Main app template ──────────────────────────────────────────────────────

export function appTemplate() {
  const state = getState();
  const linkCount = parseUrlList(state.urls).length;
  const hasContent = state.urls.trim().length > 0;
  const isExpanded = hasContent || linkCount > 1 || state.isInputFocused;

  return html`
    <main class="stage">
      ${navTemplate()} ${mascotTemplate(state.mascotState)}
      ${omniboxTemplate({
        onRef: (el) => {
          urlInputRef.value = el;
        },
        linkCount,
        hasContent,
        isExpanded,
        isFocused: state.isInputFocused,
        isBusy: state.isBusy,
        urls: state.urls,
        options: state.options,
        onSubmit: handleSubmit,
        onInput: handleUrlInput,
        onFocus: handleFocus,
        onBlur: handleBlur,
        onPaste: handlePaste,
        onClear: handleClearInput,
      })}
      ${switcherTemplate(state.options)} ${quickActionsTemplate()}
      ${resultsAreaTemplate(state.results)}
    </main>
    ${footerTemplate(state.health)}
  `;
}
