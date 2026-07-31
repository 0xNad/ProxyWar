import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
} from "./AppShellChrome";
import { fetchReadModel, PublicBuilder, ReadModel } from "./ReadModelSchema";
import { translateText } from "../Utils";

type LoadState = "loading" | "ready" | "error";

const STATUS_BADGE: Record<
  PublicBuilder["status"],
  { label: string; cls: string }
> = {
  verified: {
    label: translateText("builders_directory.status_verified"),
    cls: "border-positive/40 bg-positive/10 text-positive",
  },
  house: {
    label: translateText("builders_directory.status_house"),
    cls: "border-caution/40 bg-caution/10 text-caution",
  },
  unclaimed: {
    label: translateText("builders_directory.status_unclaimed"),
    cls: "border-line bg-surface-2 text-ink-muted",
  },
};

/**
 * `/builders` — the public builders directory (spec §4's fifth primary nav
 * destination). Lists every `PublicBuilder` from the shared read model
 * (`ReadModelSchema.ts`), each linking to its own `/builder/:slug` profile
 * (`BuilderProfilePage.ts`).
 *
 * Builder identity in this overhaul is claim-gated: a `PublicBuilder` only
 * exists once a claim has been verified (or is house/unclaimed by
 * provenance) — never invented from an agent's raw `builderDisplayName`.
 * As of this component shipping, 0 `BuilderProfile`s have been seeded by
 * the identity registry work landed so far, so the common real-world state
 * is an EMPTY `builders` array. This renders honest copy for that case,
 * never a blank screen and never a fabricated placeholder builder.
 */
@customElement("builders-directory-page")
export class BuildersDirectoryPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private readModel: ReadModel | null = null;

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `PlayerProfilePage`/`PremiereAccountPage`.
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    try {
      this.readModel = await fetchReadModel();
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/builders", undefined, this.readModel?.links.accountUrl)}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 class="mb-2 text-xl font-bold text-ink">
          ${translateText("builders_directory.title")}
        </h1>
        <p class="mb-6 text-sm text-ink-muted">
          ${translateText("builders_directory.subtitle")}
        </p>
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "ready" && this.readModel !== null
          ? this.renderDirectory(this.readModel.builders)
          : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("builders_directory.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("builders_directory.error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("builders_directory.retry")}
        </button>
      </div>
    `;
  }

  private renderDirectory(builders: ReadonlyArray<PublicBuilder>) {
    if (builders.length === 0) {
      return html`
        <p
          class="rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-muted"
        >
          ${translateText("builders_directory.empty")}
        </p>
      `;
    }
    return html`
      <ul class="flex flex-col gap-2" role="list">
        ${builders.map((builder) => this.renderBuilderRow(builder))}
      </ul>
    `;
  }

  private renderBuilderRow(builder: PublicBuilder): TemplateResult {
    const badge = STATUS_BADGE[builder.status];
    const label = builder.displayName ?? builder.slug;
    return html`
      <li>
        <a
          href="/builder/${encodeURIComponent(builder.slug)}"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm no-underline outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span class="font-semibold text-ink">${label}</span>
          <span
            class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
            >${badge.label}</span
          >
          ${builder.shortBio !== null
            ? html`<span class="basis-full text-xs text-ink-muted"
                >${builder.shortBio}</span
              >`
            : nothing}
        </a>
      </li>
    `;
  }
}
