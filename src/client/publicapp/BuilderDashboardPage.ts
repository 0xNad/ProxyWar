import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { z } from "zod";
import { translateText } from "../Utils";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  requestUpdateWhenTranslationsReady,
} from "./AppShellChrome";
import { fetchReadModel } from "./ReadModelSchema";

type LoadState = "loading" | "ready" | "auth-required" | "error";

// ---------------------------------------------------------------------
// Wire schemas.
//
// `GET /api/account/builder-dashboard` and `POST
// /api/account/version-releases` are NOT built yet — this file writes
// against the exact response shape this task's assignment documents (the
// `BuilderDashboardResponse` interface) and against
// `PlatformVersionReleaseStore.ts`'s already-committed
// `VersionReleaseSubmission` for the release-form request body (minus
// `accountId`, server-derived from the session, same convention
// `PlatformBuilderClaimStore.submitClaim`'s HTTP caller already uses).
// The integrator MUST true up the route paths/shapes below once that
// track lands — see this file's own report entry for the assumption.
// ---------------------------------------------------------------------

const accountResponseSchema = z.object({
  schemaVersion: z.literal(1),
  csrfToken: z.string(),
  identity: z.object({
    accountId: z.string(),
    displayName: z.string().nullable(),
    githubLogin: z.string().nullable(),
    githubAvatarUrl: z.string().nullable(),
  }),
  claims: z.array(z.unknown()),
});
type AccountResponse = z.infer<typeof accountResponseSchema>;

const dashboardMatchSchema = z.object({
  matchId: z.string(),
  completedAt: z.string().nullable(),
  watchHref: z.string().nullable(),
  replayHref: z.string().nullable(),
});

const dashboardNextEventSchema = z.object({
  scheduledAt: z.string(),
  premiereHref: z.string().nullable(),
});

const dashboardAgentSchema = z.object({
  agentId: z.string(),
  slug: z.string().nullable(),
  displayName: z.string(),
  rank: z.number().nullable(),
  score: z.number().nullable(),
  activeVersionLabel: z.string().nullable(),
  degradedRate: z.number().nullable(),
  latestMatch: dashboardMatchSchema.nullable(),
  nextScheduledEvent: dashboardNextEventSchema.nullable(),
});
type DashboardAgent = z.infer<typeof dashboardAgentSchema>;

const pendingReleaseSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  versionLabel: z.string(),
  status: z.enum(["pending", "observed", "stale"]),
  createdAt: z.string(),
});
type PendingRelease = z.infer<typeof pendingReleaseSchema>;

const dashboardClaimSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  state: z.string(),
  updatedAt: z.string(),
});

const builderDashboardResponseSchema = z.object({
  schemaVersion: z.literal(1),
  isVerifiedBuilder: z.boolean(),
  builder: z
    .object({
      id: z.string(),
      slug: z.string(),
      displayName: z.string().nullable(),
    })
    .nullable(),
  agents: z.array(dashboardAgentSchema),
  pendingReleases: z.array(pendingReleaseSchema),
  claims: z.array(dashboardClaimSchema),
});
type BuilderDashboardResponse = z.infer<typeof builderDashboardResponseSchema>;

const errorResponseSchema = z.object({
  error: z.object({ code: z.string() }),
});

const RELEASE_STATUS_BADGE: Record<
  PendingRelease["status"],
  { labelKey: string; cls: string }
> = {
  pending: {
    labelKey: "builder_dashboard.release_status_pending",
    cls: "border-line bg-surface-2 text-ink-muted",
  },
  observed: {
    labelKey: "builder_dashboard.release_status_observed",
    cls: "border-positive/40 bg-positive/10 text-positive",
  },
  stale: {
    labelKey: "builder_dashboard.release_status_stale",
    cls: "border-caution/40 bg-caution/10 text-caution",
  },
};

/** Same six-state palette `BuilderClaimPage.ts`'s `CLAIM_STATE_BADGE` uses — duplicated locally (not imported) since `claims` here is the assumed dashboard route's own trimmed `{id, agentId, state, updatedAt}` shape, typed as plain `string`, not that page's full `BuilderClaimRecord`. A state this page has never seen (a future addition to the state machine) falls through to `unknown`, never a thrown lookup. */
const CLAIM_STATE_BADGE: Record<string, { labelKey: string; cls: string }> = {
  draft: {
    labelKey: "builder_dashboard.claim_state_draft",
    cls: "border-line bg-surface-2 text-ink-muted",
  },
  challenge_issued: {
    labelKey: "builder_dashboard.claim_state_challenge_issued",
    cls: "border-accent/40 bg-accent/10 text-accent",
  },
  proof_pending: {
    labelKey: "builder_dashboard.claim_state_proof_pending",
    cls: "border-caution/40 bg-caution/10 text-caution",
  },
  verified: {
    labelKey: "builder_dashboard.claim_state_verified",
    cls: "border-positive/40 bg-positive/10 text-positive",
  },
  rejected: {
    labelKey: "builder_dashboard.claim_state_rejected",
    cls: "border-danger/40 bg-danger/10 text-danger",
  },
  revoked: {
    labelKey: "builder_dashboard.claim_state_revoked",
    cls: "border-danger/40 bg-danger/10 text-danger",
  },
  unknown: {
    labelKey: "builder_dashboard.claim_state_unknown",
    cls: "border-line bg-surface-2 text-ink-muted",
  },
};

function errorCodeOf(body: unknown): string | null {
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
}

function releaseErrorMessage(code: string | null): string {
  switch (code) {
    case "PLATFORM_INVALID_REQUEST":
      return translateText("builder_dashboard.release_error_invalid");
    case "PLATFORM_UNAVAILABLE":
      return translateText("builder_dashboard.release_error_unavailable");
    default:
      return translateText("builder_dashboard.release_error_generic");
  }
}

/**
 * `/builder-dashboard` — the builder-improvement loop's own surface
 * (Season Zero Phase 6): per-agent standing/version/degraded-rate at a
 * glance, the account's pending version-release records, and its claim
 * status, plus a mini-form to start a new release notice.
 *
 * `GET /api/account/builder-dashboard` and `POST
 * /api/account/version-releases` are sibling tracks' routes, not yet
 * wired when this file was written — see the module-level wire-schema
 * comment above for the exact assumed shapes and the report entry this
 * task returns for the integrator to true them up against.
 *
 * Auth failure (session not recognized) and "not yet a verified builder"
 * are two DISTINCT honest states, never the same blank-page fallback: the
 * former links to the platform account authority to sign in, the latter
 * links to `/claim` — the only path that ever turns an account into a
 * verified builder (see `BuilderClaimPage.ts`'s module doc).
 */
@customElement("builder-dashboard-page")
export class BuilderDashboardPage extends LitElement {
  @state() private loadState: LoadState = "loading";
  @state() private dashboard: BuilderDashboardResponse | null = null;
  @state() private csrfToken: string | null = null;
  @state() private accountUrl = "/account";

  @state() private releaseAgentId = "";
  @state() private releaseVersionLabel = "";
  @state() private releaseNotes = "";
  @state() private releaseBaseModel = "";
  @state() private releaseScaffoldDescription = "";
  @state() private releaseSourceDisclosure = "";
  @state() private releaseIntendedChanges = "";
  @state() private releaseSubmitting = false;
  @state() private releaseError: string | null = null;

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `BuilderClaimPage`/`BuilderProfilePage`.
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    requestUpdateWhenTranslationsReady(this);
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    const [account] = await Promise.all([
      this.fetchAccount(),
      this.loadAccountUrl(),
    ]);
    this.csrfToken = account?.csrfToken ?? null;
    await this.loadDashboard();
  }

  private async loadAccountUrl(): Promise<void> {
    try {
      const readModel = await fetchReadModel();
      this.accountUrl = readModel.links.accountUrl;
    } catch {
      // Non-fatal: the header/sign-in link falls back to the same-origin
      // "/account" default already set as the initial state value.
    }
  }

  private async fetchAccount(): Promise<AccountResponse | null> {
    try {
      const response = await fetch("/api/account", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return null;
      const body: unknown = await response.json().catch(() => null);
      const parsed = accountResponseSchema.safeParse(body);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async loadDashboard(): Promise<void> {
    try {
      const response = await fetch("/api/account/builder-dashboard", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) {
        this.loadState = "auth-required";
        return;
      }
      if (!response.ok) {
        this.loadState = "error";
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const parsed = builderDashboardResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.loadState = "error";
        return;
      }
      this.dashboard = parsed.data;
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
    }
  }

  private resetReleaseForm(): void {
    this.releaseAgentId = "";
    this.releaseVersionLabel = "";
    this.releaseNotes = "";
    this.releaseBaseModel = "";
    this.releaseScaffoldDescription = "";
    this.releaseSourceDisclosure = "";
    this.releaseIntendedChanges = "";
  }

  private async submitRelease(event: Event): Promise<void> {
    event.preventDefault();
    if (this.releaseSubmitting || this.csrfToken === null) return;
    const versionLabel = this.releaseVersionLabel.trim();
    if (this.releaseAgentId === "" || versionLabel === "") {
      this.releaseError = translateText(
        "builder_dashboard.release_validation_error",
      );
      return;
    }
    this.releaseError = null;
    this.releaseSubmitting = true;
    try {
      const response = await fetch("/api/account/version-releases", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": this.csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          agentId: this.releaseAgentId,
          versionLabel,
          releaseNotes:
            this.releaseNotes.trim() === "" ? null : this.releaseNotes.trim(),
          baseModel:
            this.releaseBaseModel.trim() === ""
              ? null
              : this.releaseBaseModel.trim(),
          scaffoldDescription:
            this.releaseScaffoldDescription.trim() === ""
              ? null
              : this.releaseScaffoldDescription.trim(),
          sourceDisclosure:
            this.releaseSourceDisclosure.trim() === ""
              ? null
              : this.releaseSourceDisclosure.trim(),
          intendedChanges:
            this.releaseIntendedChanges.trim() === ""
              ? null
              : this.releaseIntendedChanges.trim(),
        }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        this.releaseError = releaseErrorMessage(errorCodeOf(body));
        return;
      }
      this.resetReleaseForm();
      await this.loadDashboard();
    } catch {
      this.releaseError = translateText(
        "builder_dashboard.release_error_generic",
      );
    } finally {
      this.releaseSubmitting = false;
    }
  }

  render() {
    return html`
      ${appShellHeader(null, undefined, this.accountUrl)}
      <main class="mx-auto w-full max-w-4xl px-4 py-8">
        <h1 class="mb-6 text-xl font-bold text-ink">
          ${translateText("builder_dashboard.heading")}
        </h1>
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "auth-required"
          ? this.renderAuthRequired()
          : nothing}
        ${this.loadState === "ready" && this.dashboard !== null
          ? this.renderDashboard(this.dashboard)
          : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("builder_dashboard.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("builder_dashboard.load_error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("builder_dashboard.retry")}
        </button>
      </div>
    `;
  }

  private renderAuthRequired() {
    return html`
      <div class="rounded-md border border-line bg-surface-2 px-4 py-3 text-sm">
        <p class="mb-2 font-semibold text-ink">
          ${translateText("builder_dashboard.auth_required_heading")}
        </p>
        <p class="mb-3 text-ink-muted">
          ${translateText("builder_dashboard.auth_required_body")}
        </p>
        <a
          href=${this.accountUrl}
          class="inline-block font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("builder_dashboard.auth_required_cta")}</a
        >
      </div>
    `;
  }

  private renderNotVerified() {
    return html`
      <div class="rounded-md border border-line bg-surface-2 px-4 py-3 text-sm">
        <p class="mb-2 font-semibold text-ink">
          ${translateText("builder_dashboard.not_verified_heading")}
        </p>
        <p class="mb-3 text-ink-muted">
          ${translateText("builder_dashboard.not_verified_body")}
        </p>
        <a
          href="/claim"
          class="inline-block font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("builder_dashboard.not_verified_cta")}</a
        >
      </div>
    `;
  }

  private renderDashboard(dashboard: BuilderDashboardResponse) {
    if (!dashboard.isVerifiedBuilder) return this.renderNotVerified();
    return html`
      ${dashboard.builder !== null
        ? html`<p class="mb-6 text-sm text-ink-muted">
            ${translateText("builder_dashboard.builder_label")}:
            <span class="font-semibold text-ink"
              >${dashboard.builder.displayName ?? dashboard.builder.slug}</span
            >
          </p>`
        : nothing}
      ${dashboard.agents.length === 0
        ? html`<p class="mb-6 text-sm text-ink-muted">
            ${translateText("builder_dashboard.no_agents")}
          </p>`
        : html`<ul
            class="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2"
            role="list"
          >
            ${dashboard.agents.map((agent) => this.renderAgentCard(agent))}
          </ul>`}
      ${this.renderReleasesSection(dashboard)}
      ${this.renderClaimsSection(dashboard)}
    `;
  }

  private renderAgentCard(agent: DashboardAgent): TemplateResult {
    const degradedTone =
      agent.degradedRate !== null && agent.degradedRate > 0
        ? "text-caution"
        : "text-ink";
    return html`
      <li class="rounded-md border border-line bg-surface-2 p-4 text-sm">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <span class="font-semibold text-ink">${agent.displayName}</span>
          ${agent.rank !== null
            ? html`<span class="font-mono text-xs text-ink-muted"
                >#${agent.rank}</span
              >`
            : nothing}
        </div>
        <dl class="mb-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt class="uppercase text-ink-muted">
              ${translateText("builder_dashboard.score_label")}
            </dt>
            <dd class="font-mono font-semibold text-ink">
              ${agent.score === null ? "—" : agent.score.toFixed(2)}
            </dd>
          </div>
          <div>
            <dt class="uppercase text-ink-muted">
              ${translateText("builder_dashboard.active_version_label")}
            </dt>
            <dd class="font-mono font-semibold text-ink">
              ${agent.activeVersionLabel ?? "—"}
            </dd>
          </div>
          <div>
            <dt class="uppercase text-ink-muted">
              ${translateText("builder_dashboard.degraded_rate_label")}
            </dt>
            <dd class="font-semibold ${degradedTone}">
              ${agent.degradedRate === null
                ? translateText("builder_dashboard.degraded_rate_unknown")
                : `${(agent.degradedRate * 100).toFixed(1)}%`}
            </dd>
          </div>
        </dl>
        ${agent.latestMatch !== null
          ? this.renderLatestMatch(agent.latestMatch)
          : html`<p class="mb-1 text-xs text-ink-muted">
              ${translateText("builder_dashboard.no_matches_yet")}
            </p>`}
        ${agent.nextScheduledEvent !== null
          ? this.renderNextEvent(agent.nextScheduledEvent)
          : nothing}
      </li>
    `;
  }

  private renderLatestMatch(
    match: NonNullable<DashboardAgent["latestMatch"]>,
  ): TemplateResult {
    const when =
      match.completedAt !== null
        ? new Date(match.completedAt).toLocaleDateString()
        : "—";
    return html`
      <p class="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span
          >${translateText("builder_dashboard.latest_match_label")}:
          ${when}</span
        >
        <a
          href="/match/${encodeURIComponent(match.matchId)}"
          class="font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("builder_dashboard.view_match_link")}</a
        >
        ${match.watchHref !== null
          ? html`<a
              href=${match.watchHref}
              class="font-semibold text-ink-muted no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("builder_dashboard.watch_link")}</a
            >`
          : nothing}
        ${match.replayHref !== null
          ? html`<a
              href=${match.replayHref}
              class="font-semibold text-ink-muted no-underline outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("builder_dashboard.replay_link")}</a
            >`
          : nothing}
      </p>
    `;
  }

  private renderNextEvent(
    event: NonNullable<DashboardAgent["nextScheduledEvent"]>,
  ): TemplateResult {
    return html`
      <p class="text-xs text-ink-muted">
        ${translateText("builder_dashboard.next_event_label")}:
        ${new Date(event.scheduledAt).toLocaleString()}
        ${event.premiereHref !== null
          ? html`<a
              href=${event.premiereHref}
              class="ml-2 font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
              >${translateText("builder_dashboard.premiere_link")}</a
            >`
          : nothing}
      </p>
    `;
  }

  private renderReleasesSection(dashboard: BuilderDashboardResponse) {
    return html`
      <section
        class="mb-8"
        aria-labelledby="builder-dashboard-releases-heading"
      >
        <h2
          id="builder-dashboard-releases-heading"
          class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
        >
          ${translateText("builder_dashboard.releases_heading")}
        </h2>
        ${dashboard.pendingReleases.length === 0
          ? html`<p class="mb-3 text-sm text-ink-muted">
              ${translateText("builder_dashboard.no_releases")}
            </p>`
          : html`<ul class="mb-3 flex flex-col gap-2" role="list">
              ${dashboard.pendingReleases.map((release) =>
                this.renderReleaseRow(release, dashboard),
              )}
            </ul>`}
        ${this.renderReleaseForm(dashboard)}
      </section>
    `;
  }

  private renderReleaseRow(
    release: PendingRelease,
    dashboard: BuilderDashboardResponse,
  ): TemplateResult {
    const agent = dashboard.agents.find((a) => a.agentId === release.agentId);
    const badge = RELEASE_STATUS_BADGE[release.status];
    return html`
      <li
        class="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm"
      >
        <span class="font-semibold text-ink"
          >${agent?.displayName ?? release.agentId}</span
        >
        <span class="font-mono text-xs text-ink-muted"
          >${release.versionLabel}</span
        >
        <span
          class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
          >${translateText(badge.labelKey)}</span
        >
        <span class="ml-auto text-xs text-ink-muted"
          >${new Date(release.createdAt).toLocaleDateString()}</span
        >
      </li>
    `;
  }

  private renderReleaseForm(dashboard: BuilderDashboardResponse) {
    if (dashboard.agents.length === 0) return nothing;
    return html`
      <form
        class="flex flex-col gap-3 rounded-md border border-line bg-surface-2 p-4"
        @submit=${(event: Event) => this.submitRelease(event)}
      >
        <h3 class="text-sm font-bold text-ink">
          ${translateText("builder_dashboard.new_release_heading")}
        </h3>
        <label class="flex flex-col gap-1 text-xs">
          <span class="font-semibold text-ink"
            >${translateText("builder_dashboard.release_agent_label")}</span
          >
          <select
            .value=${this.releaseAgentId}
            @change=${(event: Event) =>
              (this.releaseAgentId = (event.target as HTMLSelectElement).value)}
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            required
          >
            <option value="">
              ${translateText("builder_dashboard.release_agent_placeholder")}
            </option>
            ${dashboard.agents.map(
              (agent) =>
                html`<option value=${agent.agentId}>
                  ${agent.displayName}
                </option>`,
            )}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="font-semibold text-ink"
            >${translateText("builder_dashboard.release_version_label")}</span
          >
          <input
            type="text"
            .value=${this.releaseVersionLabel}
            @input=${(event: InputEvent) =>
              (this.releaseVersionLabel = (
                event.target as HTMLInputElement
              ).value)}
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            required
          />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="font-semibold text-ink"
            >${translateText("builder_dashboard.release_notes_label")}</span
          >
          <textarea
            .value=${this.releaseNotes}
            @input=${(event: InputEvent) =>
              (this.releaseNotes = (event.target as HTMLTextAreaElement).value)}
            rows="2"
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
        </label>
        <details class="text-xs text-ink-muted">
          <summary class="cursor-pointer font-semibold text-ink">
            ${translateText("builder_dashboard.release_more_details")}
          </summary>
          <div class="mt-2 flex flex-col gap-2">
            <label class="flex flex-col gap-1">
              <span
                >${translateText(
                  "builder_dashboard.release_base_model_label",
                )}</span
              >
              <input
                type="text"
                .value=${this.releaseBaseModel}
                @input=${(event: InputEvent) =>
                  (this.releaseBaseModel = (
                    event.target as HTMLInputElement
                  ).value)}
                class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span
                >${translateText(
                  "builder_dashboard.release_scaffold_label",
                )}</span
              >
              <input
                type="text"
                .value=${this.releaseScaffoldDescription}
                @input=${(event: InputEvent) =>
                  (this.releaseScaffoldDescription = (
                    event.target as HTMLInputElement
                  ).value)}
                class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span
                >${translateText(
                  "builder_dashboard.release_source_label",
                )}</span
              >
              <input
                type="text"
                .value=${this.releaseSourceDisclosure}
                @input=${(event: InputEvent) =>
                  (this.releaseSourceDisclosure = (
                    event.target as HTMLInputElement
                  ).value)}
                class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span
                >${translateText(
                  "builder_dashboard.release_intended_changes_label",
                )}</span
              >
              <input
                type="text"
                .value=${this.releaseIntendedChanges}
                @input=${(event: InputEvent) =>
                  (this.releaseIntendedChanges = (
                    event.target as HTMLInputElement
                  ).value)}
                class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
          </div>
        </details>
        ${this.releaseError !== null
          ? html`<p class="text-xs text-danger" role="alert">
              ${this.releaseError}
            </p>`
          : nothing}
        <button
          type="submit"
          ?disabled=${this.releaseSubmitting}
          class="self-start rounded bg-accent px-4 py-2 text-xs font-bold text-white outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          ${this.releaseSubmitting
            ? translateText("builder_dashboard.release_submitting_button")
            : translateText("builder_dashboard.release_submit_button")}
        </button>
      </form>
    `;
  }

  private renderClaimsSection(dashboard: BuilderDashboardResponse) {
    if (dashboard.claims.length === 0) return nothing;
    return html`
      <section aria-labelledby="builder-dashboard-claims-heading">
        <h2
          id="builder-dashboard-claims-heading"
          class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
        >
          ${translateText("builder_dashboard.claims_heading")}
        </h2>
        <ul class="mb-2 flex flex-col gap-2" role="list">
          ${dashboard.claims.map((claim) =>
            this.renderClaimRow(claim, dashboard),
          )}
        </ul>
        <a
          href="/claim"
          class="inline-block text-xs font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("builder_dashboard.manage_claims_link")}</a
        >
      </section>
    `;
  }

  private renderClaimRow(
    claim: BuilderDashboardResponse["claims"][number],
    dashboard: BuilderDashboardResponse,
  ): TemplateResult {
    const agent = dashboard.agents.find((a) => a.agentId === claim.agentId);
    const badge = CLAIM_STATE_BADGE[claim.state] ?? CLAIM_STATE_BADGE.unknown;
    return html`
      <li
        class="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm"
      >
        <span class="font-semibold text-ink"
          >${agent?.displayName ?? claim.agentId}</span
        >
        <span
          class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
          >${translateText(badge.labelKey)}</span
        >
        <span class="ml-auto text-xs text-ink-muted"
          >${new Date(claim.updatedAt).toLocaleDateString()}</span
        >
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "builder-dashboard-page": BuilderDashboardPage;
  }
}
