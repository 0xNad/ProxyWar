import { html } from "lit";

/**
 * The Crown's mark on the front page and `/world`: a pixel crown with a
 * raised centre (a flat one reads as battlements), drawn on a 9 × 5 grid so
 * it stays crisp at small sizes and matches the pixel map it sits on. Sized
 * by its container; takes the text colour.
 */
export const CROWN_GLYPH = html`<svg
  class="crown-glyph"
  viewBox="0 0 9 5"
  fill="currentColor"
  aria-hidden="true"
  shape-rendering="crispEdges"
>
  <path
    d="M4 0h1v1H4zM0 1h1v1H0zM3 1h3v1H3zM8 1h1v1H8zM0 2h2v1H0zM3 2h3v1H3zM7 2h2v1H7zM0 3h9v2H0z"
  />
</svg>`;
