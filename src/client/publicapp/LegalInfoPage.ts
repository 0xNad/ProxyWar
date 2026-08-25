import { html, LitElement, TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";

import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  requestUpdateWhenTranslationsReady,
} from "./AppShellChrome";

type LegalPageKind = "privacy" | "terms" | "credits";

interface LegalSection {
  readonly headingKey: string;
  readonly paragraphKeys: readonly string[];
  readonly listKeys?: readonly string[];
}

const SECTIONS: Readonly<Record<LegalPageKind, readonly LegalSection[]>> = {
  privacy: [
    {
      headingKey: "legal.privacy_data_heading",
      paragraphKeys: ["legal.privacy_data_intro"],
      listKeys: [
        "legal.privacy_data_analytics",
        "legal.privacy_data_account",
        "legal.privacy_data_github",
        "legal.privacy_data_league",
      ],
    },
    {
      headingKey: "legal.privacy_use_heading",
      paragraphKeys: ["legal.privacy_use_text"],
    },
    {
      headingKey: "legal.privacy_retention_heading",
      paragraphKeys: [
        "legal.privacy_retention_analytics",
        "legal.privacy_retention_account",
      ],
    },
    {
      headingKey: "legal.privacy_services_heading",
      paragraphKeys: ["legal.privacy_services_text"],
    },
    {
      headingKey: "legal.privacy_control_heading",
      paragraphKeys: ["legal.privacy_control_text"],
    },
  ],
  terms: [
    {
      headingKey: "legal.terms_service_heading",
      paragraphKeys: ["legal.terms_service_text"],
    },
    {
      headingKey: "legal.terms_accounts_heading",
      paragraphKeys: ["legal.terms_accounts_text"],
    },
    {
      headingKey: "legal.terms_submissions_heading",
      paragraphKeys: ["legal.terms_submissions_text"],
    },
    {
      headingKey: "legal.terms_conduct_heading",
      paragraphKeys: ["legal.terms_conduct_intro"],
      listKeys: [
        "legal.terms_conduct_security",
        "legal.terms_conduct_integrity",
        "legal.terms_conduct_rights",
      ],
    },
    {
      headingKey: "legal.terms_results_heading",
      paragraphKeys: ["legal.terms_results_text"],
    },
    {
      headingKey: "legal.terms_licenses_heading",
      paragraphKeys: ["legal.terms_licenses_text"],
    },
    {
      headingKey: "legal.terms_changes_heading",
      paragraphKeys: ["legal.terms_changes_text"],
    },
  ],
  credits: [
    {
      headingKey: "legal.credits_platform_heading",
      paragraphKeys: ["legal.credits_platform_text"],
    },
    {
      headingKey: "legal.credits_game_heading",
      paragraphKeys: ["legal.credits_game_text"],
    },
    {
      headingKey: "legal.credits_contributors_heading",
      paragraphKeys: ["legal.credits_contributors_text"],
    },
    {
      headingKey: "legal.credits_assets_heading",
      paragraphKeys: ["legal.credits_assets_text"],
    },
  ],
};

function currentKind(): LegalPageKind {
  if (window.location.pathname === "/privacy") return "privacy";
  if (window.location.pathname === "/terms") return "terms";
  return "credits";
}

/** Truthful, first-party legal and attribution pages for the public product. */
@customElement("legal-info-page")
export class LegalInfoPage extends LitElement {
  createRenderRoot() {
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    requestUpdateWhenTranslationsReady(this);
  }

  render(): TemplateResult {
    const kind = currentKind();
    return html`
      ${appShellHeader(null)}
      <main class="mx-auto w-full max-w-3xl px-4 py-10">
        <h1 class="mb-2 text-2xl font-bold text-ink">
          ${translateText(`legal.${kind}_title`)}
        </h1>
        <p class="mb-8 font-mono text-xs text-ink-muted">
          ${translateText("legal.last_updated")}
        </p>
        ${SECTIONS[kind].map((section) => this.renderSection(section))}
        ${this.renderSourceLinks(kind)}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderSection(section: LegalSection): TemplateResult {
    return html`
      <section class="mt-7">
        <h2 class="mb-2 text-lg font-bold text-ink">
          ${translateText(section.headingKey)}
        </h2>
        ${section.paragraphKeys.map(
          (key) => html`<p class="mb-2 text-sm leading-relaxed text-ink-muted">
            ${translateText(key)}
          </p>`,
        )}
        ${section.listKeys === undefined
          ? ""
          : html`<ul
              class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-muted"
            >
              ${section.listKeys.map(
                (key) => html`<li>${translateText(key)}</li>`,
              )}
            </ul>`}
      </section>
    `;
  }

  private renderSourceLinks(kind: LegalPageKind): TemplateResult {
    if (kind === "privacy") {
      return html`<p class="mt-8 text-sm text-ink-muted">
        <a
          class="font-semibold underline decoration-line hover:text-ink"
          href="https://github.com/0xNad/ProxyWar/blob/main/docs/SEASON_ZERO_ANALYTICS.md"
          rel="noopener noreferrer"
          >${translateText("legal.privacy_analytics_link")}</a
        >
      </p>`;
    }
    if (kind === "terms") {
      return html`<p class="mt-8 text-sm text-ink-muted">
        <a
          class="font-semibold underline decoration-line hover:text-ink"
          href="https://github.com/0xNad/ProxyWar/blob/main/LICENSE"
          rel="noopener noreferrer"
          >${translateText("legal.terms_license_link")}</a
        >
      </p>`;
    }
    return html`<div class="mt-8 flex flex-wrap gap-4 text-sm text-ink-muted">
      <a
        class="font-semibold underline decoration-line hover:text-ink"
        href="https://github.com/0xNad/ProxyWar/blob/main/CREDITS.md"
        rel="noopener noreferrer"
        >${translateText("legal.credits_full_link")}</a
      >
      <a
        class="font-semibold underline decoration-line hover:text-ink"
        href="https://github.com/0xNad/ProxyWar/blob/main/LICENSE-ASSETS"
        rel="noopener noreferrer"
        >${translateText("legal.credits_assets_link")}</a
      >
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "legal-info-page": LegalInfoPage;
  }
}
