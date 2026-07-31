import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
} from "./AppShellChrome";
import {
  fetchReadModel,
  PublicAgent,
  PublicBuilder,
  ReadModel,
} from "./ReadModelSchema";

type LoadState = "loading" | "ready" | "not-found" | "error";

const STATUS_BADGE: Record<
  PublicBuilder["status"],
  { labelKey: string; cls: string }
> = {
  verified: {
    labelKey: "builder_profile.status_verified",
    cls: "border-positive/40 bg-positive/10 text-positive",
  },
  house: {
    labelKey: "builder_profile.status_house",
    cls: "border-caution/40 bg-caution/10 text-caution",
  },
  unclaimed: {
    labelKey: "builder_profile.status_unclaimed",
    cls: "border-line bg-surface-2 text-ink-muted",
  },
};

/**
 * `/builder/:slug` — a single builder's public profile. Finds its
 * `PublicBuilder` by slug in the shared read model, then cross-references
 * `ReadModel.agents` for every `PublicAgent` whose `builderId` equals this
 * builder's `id` for the "Agents" section — that cross-reference, not any
 * field stored on the builder record itself, is the sole source of that
 * list (same "never invent, only render what the read model says"
 * discipline as `PlayerProfilePage`).
 *
 * Builder identity is claim-gated (see `BuildersDirectoryPage.ts`'s doc):
 * as of this component shipping, 0 `BuilderProfile`s exist yet, so hitting
 * this route for any slug renders the not-found state today — that is the
 * honest, expected outcome right now, not a bug in this page.
 */
@customElement("builder-profile-page")
export class BuilderProfilePage extends LitElement {
  @property({ type: String }) slug = "";

  @state() private loadState: LoadState = "loading";
  @state() private builder: PublicBuilder | null = null;
  @state() private agents: ReadonlyArray<PublicAgent> = [];
  @state() private accountUrl: string | null = null;

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
      const readModel: ReadModel = await fetchReadModel();
      this.accountUrl = readModel.links.accountUrl;
      const builder =
        readModel.builders.find((candidate) => candidate.slug === this.slug) ??
        null;
      if (builder === null) {
        this.builder = null;
        this.agents = [];
        this.loadState = "not-found";
        return;
      }
      this.builder = builder;
      this.agents = readModel.agents.filter(
        (agent) => agent.builderId === builder.id,
      );
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  render() {
    return html`
      ${appShellHeader("/builders", undefined, this.accountUrl ?? undefined)}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "not-found" ? this.renderNotFound() : nothing}
        ${this.loadState === "ready" && this.builder !== null
          ? this.renderProfile(this.builder, this.agents)
          : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("builder_profile.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("builder_profile.load_error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("builder_profile.retry")}
        </button>
      </div>
    `;
  }

  private renderNotFound() {
    return html`
      <h1 class="mb-2 text-xl font-bold text-ink">${this.slug}</h1>
      <p class="text-sm text-ink-muted">
        ${translateText("builder_profile.not_found_body")}
      </p>
    `;
  }

  private renderProfile(
    builder: PublicBuilder,
    agents: ReadonlyArray<PublicAgent>,
  ) {
    const badge = STATUS_BADGE[builder.status];
    const label = builder.displayName ?? builder.slug;
    return html`
      <header class="mb-5 flex flex-wrap items-center gap-2">
        <h1 class="text-xl font-bold text-ink">${label}</h1>
        <span
          class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
          >${translateText(badge.labelKey)}</span
        >
      </header>
      ${builder.shortBio !== null
        ? html`<p class="mb-6 text-sm text-ink-muted">${builder.shortBio}</p>`
        : nothing}
      ${this.renderAgentsSection(agents)}
    `;
  }

  private renderAgentsSection(agents: ReadonlyArray<PublicAgent>) {
    return html`
      <section aria-labelledby="builder-profile-agents-heading">
        <h2
          id="builder-profile-agents-heading"
          class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
        >
          ${translateText("builder_profile.agents_heading")}
        </h2>
        ${agents.length === 0
          ? html`<p class="text-sm text-ink-muted">
              ${translateText("builder_profile.no_agents")}
            </p>`
          : html`
              <ul class="flex flex-col gap-2" role="list">
                ${agents.map((agent) => this.renderAgentRow(agent))}
              </ul>
            `}
      </section>
    `;
  }

  private renderAgentRow(agent: PublicAgent): TemplateResult {
    // Registered vs unregistered identity render is the same rule as the
    // rest of the public app (see module doc / `ReadModelSchema.ts`): an
    // unregistered agent shows only its raw `playerName`, never an emblem
    // or short code, and its `slug` is expected to be null so it never
    // links to an `/agent/:slug` profile that doesn't exist for it.
    const label = agent.registered ? agent.displayName : agent.playerName;
    const href =
      agent.slug !== null ? `/agent/${encodeURIComponent(agent.slug)}` : null;
    const rowClasses =
      "flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm";
    const content = html`
      ${agent.registered && agent.emblemSvg !== null
        ? html`<span class="inline-flex h-6 w-6 shrink-0" aria-hidden="true"
            >${unsafeSVG(agent.emblemSvg)}</span
          >`
        : nothing}
      <span class="font-semibold text-ink">${label}</span>
      ${agent.registered && agent.shortCode !== null
        ? html`<span class="font-mono text-xs text-ink-muted"
            >${agent.shortCode}</span
          >`
        : nothing}
      ${agent.standing !== null
        ? html`<span class="ml-auto font-mono text-xs text-ink-muted"
            >#${agent.standing.rank}</span
          >`
        : nothing}
    `;
    return html`
      <li>
        ${href !== null
          ? html`<a
              href=${href}
              class="${rowClasses} no-underline outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent"
              >${content}</a
            >`
          : html`<div class="${rowClasses}">${content}</div>`}
      </li>
    `;
  }
}
