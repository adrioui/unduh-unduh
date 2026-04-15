/**
 * Navigation component template.
 */

import { html } from "lit-html";

export function navTemplate() {
  return html`
    <nav class="utility-nav">
      <a href="#how-it-works">How it works</a>
      <a href="#settings">Settings</a>
      <a href="#about">About</a>
    </nav>
  `;
}
