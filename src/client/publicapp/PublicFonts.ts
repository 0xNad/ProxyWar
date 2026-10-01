import { assetUrl } from "../../core/AssetUrls";

/**
 * The self-hosted display face shared by the front page and `/world`:
 * Overpass, an open-source highway-signage grotesque, registered as
 * `"PW Overpass"` so it never collides with a system-installed copy. The
 * CSP only allows same-origin fonts, so it is served from the asset
 * manifest rather than a font CDN.
 */
export const PUBLIC_DISPLAY_FONT_STACK =
  '"PW Overpass",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif';

const FONT_STYLE_ELEMENT_ID = "pw-public-fonts";

/** Injects the `@font-face` rules once per document; a no-op without an asset manifest (tests). */
export function ensurePublicFonts(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(FONT_STYLE_ELEMENT_ID) !== null) return;
  let regular: string;
  let bold: string;
  try {
    regular = assetUrl("fonts/overpass.woff");
    bold = assetUrl("fonts/overpass-bold.woff");
  } catch {
    // No asset manifest (tests): the system stack is the fallback.
    return;
  }
  const style = document.createElement("style");
  style.id = FONT_STYLE_ELEMENT_ID;
  style.textContent = `@font-face{font-family:"PW Overpass";src:url("${regular}") format("woff");font-weight:400;font-display:swap}
@font-face{font-family:"PW Overpass";src:url("${bold}") format("woff");font-weight:700;font-display:swap}`;
  document.head.appendChild(style);
}
