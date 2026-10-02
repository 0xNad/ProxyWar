import englishTranslations from "../../../resources/lang/en.json";

/**
 * A minimal `<lang-selector>` carrying the real English strings, so the real
 * `translateText()` renders a page the way a visitor reads it and a test can
 * assert whole sentences, parameters included.
 */

function flatten(
  value: unknown,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  if (typeof value === "string") {
    out[prefix] = value;
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === "" ? key : `${prefix}.${key}`, out);
    }
  }
  return out;
}

class FakeLangSelector extends HTMLElement {
  currentLang = "en";
  translations: Record<string, string> | undefined =
    flatten(englishTranslations);
  defaultTranslations: Record<string, string> | undefined = this.translations;
}

export function installEnglish(): void {
  if (!customElements.get("lang-selector")) {
    customElements.define("lang-selector", FakeLangSelector);
  }
  document.head.append(document.createElement("lang-selector"));
}

export function removeEnglish(): void {
  document.head.querySelectorAll("lang-selector").forEach((el) => el.remove());
}
