import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { z } from "zod";
import { translateText } from "../Utils";
import { analytics } from "../analytics/AnalyticsClient";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  waitForTranslationsReady,
} from "./AppShellChrome";
import { fetchReadModel, PublicAgent } from "./ReadModelSchema";

type LoadState = "loading" | "ready" | "error";

// ---------------------------------------------------------------------
// Wire schemas — client-side mirrors of the server's shapes (never
// imported directly: a server module pulling in `node:crypto`/`node:fs`
// has no business in a browser bundle). Same "duplicate the eight lines,
// don't share a util across the process boundary" call
// `PlatformVersionReleaseStore.ts` already makes against
// `PlatformBuilderClaimStore.ts`.
// ---------------------------------------------------------------------

const accountIdentitySchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
  githubLogin: z.string().nullable(),
  githubAvatarUrl: z.string().nullable(),
});
type AccountIdentity = z.infer<typeof accountIdentitySchema>;

/** Same envelope `AccountPage.ts`'s `accountResponseSchema` parses — `claims` here is that page's unrelated policy-label claim list, deliberately left unvalidated (`z.unknown()`) since this page never reads it. */
const accountResponseSchema = z.object({
  schemaVersion: z.literal(1),
  csrfToken: z.string(),
  identity: accountIdentitySchema,
  claims: z.array(z.unknown()),
});
type AccountResponse = z.infer<typeof accountResponseSchema>;

const BUILDER_CLAIM_STATES = [
  "draft",
  "challenge_issued",
  "proof_pending",
  "verified",
  "rejected",
  "revoked",
] as const;

const builderClaimRecordSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  githubLogin: z.string(),
  agentId: z.string(),
  claimedCoworldPlayerName: z.string(),
  builderProfileDraft: z.object({
    displayName: z.string(),
    shortBio: z.string().nullable(),
    links: z.array(z.string()),
    teamMembers: z.array(z.string()),
  }),
  evidence: z.array(
    z.object({
      note: z.string(),
      links: z.array(z.string()),
      submittedAt: z.string(),
    }),
  ),
  state: z.enum(BUILDER_CLAIM_STATES),
  nonceChallenge: z
    .object({
      nonce: z.string(),
      instructions: z.string(),
      issuedAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BuilderClaimRecord = z.infer<typeof builderClaimRecordSchema>;

const claimsListResponseSchema = z.object({
  schemaVersion: z.literal(1),
  claims: z.array(builderClaimRecordSchema),
});

const claimResponseSchema = z.object({
  schemaVersion: z.literal(1),
  claim: builderClaimRecordSchema,
});

const errorResponseSchema = z.object({
  error: z.object({ code: z.string() }),
});

type UnclaimedAgent = PublicAgent & { id: string; slug: string };

const CLAIM_STATE_BADGE: Record<
  BuilderClaimRecord["state"],
  { labelKey: string; cls: string }
> = {
  draft: {
    labelKey: "builder_claim.state_draft",
    cls: "border-line bg-surface-2 text-ink-muted",
  },
  challenge_issued: {
    labelKey: "builder_claim.state_challenge_issued",
    cls: "border-accent/40 bg-accent/10 text-accent",
  },
  proof_pending: {
    labelKey: "builder_claim.state_proof_pending",
    cls: "border-caution/40 bg-caution/10 text-caution",
  },
  verified: {
    labelKey: "builder_claim.state_verified",
    cls: "border-positive/40 bg-positive/10 text-positive",
  },
  rejected: {
    labelKey: "builder_claim.state_rejected",
    cls: "border-danger/40 bg-danger/10 text-danger",
  },
  revoked: {
    labelKey: "builder_claim.state_revoked",
    cls: "border-danger/40 bg-danger/10 text-danger",
  },
};

/** The state machine's own non-terminal set (see `BuilderClaimStateMachine.ts`), duplicated here as a literal — claimant self-service actions (challenge/proof/withdraw) are offered only for these. */
const NON_TERMINAL_STATES: Record<BuilderClaimRecord["state"], boolean> = {
  draft: true,
  challenge_issued: true,
  proof_pending: true,
  verified: false,
  rejected: false,
  revoked: false,
};

/** Comma- or newline-separated free text -> a trimmed, non-empty string array — the one shared parsing rule every multi-value field on this form (`builderLinks`, `teamMembers`, `evidenceLinks`) uses. */
function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function errorCodeOf(body: unknown): string | null {
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
}

/** Distinct, honest copy per submit-time failure code — see the route contract `sz-identity.ClaimsHttpAndCli` documents for the full list. */
function submitErrorMessage(code: string | null): string {
  switch (code) {
    case "PLATFORM_ALREADY_VERIFIED":
      return translateText("builder_claim.error_already_verified");
    case "PLATFORM_GITHUB_SIGNIN_REQUIRED":
      return translateText("builder_claim.error_signin_required");
    case "PLATFORM_AGENT_NOT_FOUND":
      return translateText("builder_claim.error_agent_not_found");
    case "PLATFORM_INVALID_REQUEST":
      return translateText("builder_claim.error_invalid");
    case "PLATFORM_UNAVAILABLE":
      return translateText("builder_claim.error_unavailable");
    default:
      return translateText("builder_claim.error_generic");
  }
}

/** Distinct, honest copy for the challenge/proof/withdraw action codes. */
function actionErrorMessage(code: string | null): string {
  switch (code) {
    case "PLATFORM_BUILDER_CLAIM_NOT_FOUND":
      return translateText("builder_claim.action_error_not_found");
    case "PLATFORM_BUILDER_CLAIM_INVALID_TRANSITION":
      return translateText("builder_claim.action_error_invalid_transition");
    case "PLATFORM_INVALID_REQUEST":
      return translateText("builder_claim.action_error_invalid");
    default:
      return translateText("builder_claim.action_error_generic");
  }
}

function withoutKey(
  record: Readonly<Record<string, string>>,
  key: string,
): Record<string, string> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * `/claim` and `/claim/:agentSlug` — the REAL Builder/Agent/Version
 * identity claim workflow's claimant-facing surface (Season Zero Phase 3).
 * Requires GitHub sign-in (checked via `GET /api/account`'s
 * `identity.githubLogin`, same envelope `AccountPage.ts` parses); a
 * signed-out visitor sees an honest gate, never the form, and every write
 * carries the same CSRF convention (`x-csrf-token` + `credentials:
 * "same-origin"`) that page already establishes.
 *
 * The unclaimed-agent picker reuses `BuildersDirectoryPage.ts`'s own
 * filter verbatim (`agent.builderId === null && agent.status !== "house"`)
 * — the read model, not this page, is the single source of truth for
 * which agents are actually claimable.
 *
 * Submission creates a `draft` claim via `PlatformBuilderClaimStore.
 * submitClaim` (through `POST /api/account/builder-claims`) — approval is
 * an OPERATOR-run CLI, never anything this page can trigger. Below the
 * form, this page also renders the claimant's FULL non-terminal state
 * machine UI for every claim already on the account: proof submission,
 * withdrawal, and the scaffolded (gated-off) nonce challenge path — see
 * `PolicyLabelNonceChallenge.ts`'s doc for why that path is safe to expose
 * even while `PROXYWAR_ENABLE_NONCE_AUTO_VERIFY` stays unset.
 */
@customElement("builder-claim-page")
export class BuilderClaimPage extends LitElement {
  @property({ type: String, attribute: "agent-slug" }) agentSlug = "";

  @state() private loadState: LoadState = "loading";
  @state() private identity: AccountIdentity | null = null;
  @state() private csrfToken: string | null = null;
  @state() private accountUrl = "/account";
  @state() private unclaimedAgents: ReadonlyArray<UnclaimedAgent> = [];
  @state() private agentsById: ReadonlyMap<string, PublicAgent> = new Map();
  @state() private myClaims: ReadonlyArray<BuilderClaimRecord> = [];

  @state() private selectedAgentId = "";
  @state() private claimedCoworldPlayerName = "";
  @state() private builderDisplayName = "";
  @state() private builderShortBio = "";
  @state() private builderLinksText = "";
  @state() private teamMembersText = "";
  @state() private evidenceNote = "";
  @state() private evidenceLinksText = "";
  @state() private formError: string | null = null;
  @state() private submitting = false;
  @state() private submitError: string | null = null;
  @state() private submittedClaim: BuilderClaimRecord | null = null;
  @state() private submittedAgentSlug: string | null = null;

  @state() private busyClaimId: string | null = null;
  @state() private claimActionError: Readonly<Record<string, string>> = {};
  @state() private proofDraftByClaimId: Readonly<Record<string, string>> = {};
  @state() private withdrawConfirmClaimId: string | null = null;

  createRenderRoot() {
    // Light DOM, so page-level Tailwind applies — same reasoning as
    // `BuilderProfilePage`/`AgentProfilePage`.
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void waitForTranslationsReady().then(() => this.requestUpdate());
  }

  private async load(): Promise<void> {
    this.loadState = "loading";
    try {
      const [readModel, account] = await Promise.all([
        fetchReadModel(),
        this.fetchAccount(),
      ]);
      this.accountUrl = readModel.links.accountUrl;
      this.agentsById = new Map(
        readModel.agents
          .filter((agent): agent is PublicAgent & { id: string } => agent.id !== null)
          .map((agent) => [agent.id, agent]),
      );
      this.unclaimedAgents = readModel.agents.filter(
        (agent): agent is UnclaimedAgent =>
          agent.id !== null &&
          agent.slug !== null &&
          agent.builderId === null &&
          agent.status !== "house",
      );
      if (this.agentSlug !== "" && this.selectedAgentId === "") {
        const preselected = this.unclaimedAgents.find(
          (agent) => agent.slug === this.agentSlug,
        );
        this.selectedAgentId = preselected?.id ?? "";
      }
      this.identity = account?.identity ?? null;
      this.csrfToken = account?.csrfToken ?? null;
      if (this.identity?.githubLogin !== null && this.identity?.githubLogin !== undefined) {
        await this.loadMyClaims();
      }
      this.loadState = "ready";
    } catch {
      this.loadState = "error";
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

  private async loadMyClaims(): Promise<void> {
    try {
      const response = await fetch("/api/account/builder-claims", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return;
      const body: unknown = await response.json().catch(() => null);
      const parsed = claimsListResponseSchema.safeParse(body);
      if (parsed.success) this.myClaims = parsed.data.claims;
    } catch {
      // Non-fatal: the claim list is a secondary section below the
      // submission form, which stays usable even if this silently no-ops.
    }
  }

  private async submitClaim(event: Event): Promise<void> {
    event.preventDefault();
    if (this.submitting || this.csrfToken === null) return;
    const agentId = this.selectedAgentId;
    const playerName = this.claimedCoworldPlayerName.trim();
    const displayName = this.builderDisplayName.trim();
    const evidenceNote = this.evidenceNote.trim();
    if (
      agentId === "" ||
      playerName === "" ||
      displayName === "" ||
      evidenceNote === ""
    ) {
      this.formError = translateText("builder_claim.validation_error");
      return;
    }
    this.formError = null;
    this.submitError = null;
    this.submitting = true;
    try {
      const response = await fetch("/api/account/builder-claims", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-csrf-token": this.csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          agentId,
          claimedCoworldPlayerName: playerName,
          builderDisplayName: displayName,
          builderShortBio:
            this.builderShortBio.trim() === ""
              ? null
              : this.builderShortBio.trim(),
          builderLinks: parseListInput(this.builderLinksText),
          teamMembers: parseListInput(this.teamMembersText),
          evidenceNote,
          evidenceLinks: parseListInput(this.evidenceLinksText),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        this.submitError = submitErrorMessage(errorCodeOf(body));
        return;
      }
      const parsed = claimResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.submitError = translateText("builder_claim.error_generic");
        return;
      }
      this.submittedClaim = parsed.data.claim;
      this.submittedAgentSlug =
        this.unclaimedAgents.find((agent) => agent.id === agentId)?.slug ??
        null;
      analytics.track("claim_started", {
        claimId: parsed.data.claim.id,
        ...(this.submittedAgentSlug !== null
          ? { agentSlug: this.submittedAgentSlug }
          : {}),
      });
      this.resetForm();
      await this.loadMyClaims();
    } catch {
      this.submitError = translateText("builder_claim.error_generic");
    } finally {
      this.submitting = false;
    }
  }

  private resetForm(): void {
    this.selectedAgentId = "";
    this.claimedCoworldPlayerName = "";
    this.builderDisplayName = "";
    this.builderShortBio = "";
    this.builderLinksText = "";
    this.teamMembersText = "";
    this.evidenceNote = "";
    this.evidenceLinksText = "";
  }

  private startAnotherClaim(): void {
    this.submittedClaim = null;
    this.submittedAgentSlug = null;
  }

  private async runClaimAction(
    claimId: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<BuilderClaimRecord | null> {
    if (this.csrfToken === null) return null;
    const response = await fetch(path, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-csrf-token": this.csrfToken,
      },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    const responseBody: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      this.claimActionError = {
        ...this.claimActionError,
        [claimId]: actionErrorMessage(errorCodeOf(responseBody)),
      };
      return null;
    }
    const parsed = claimResponseSchema.safeParse(responseBody);
    return parsed.success ? parsed.data.claim : null;
  }

  private applyUpdatedClaim(claim: BuilderClaimRecord): void {
    this.myClaims = this.myClaims.map((candidate) =>
      candidate.id === claim.id ? claim : candidate,
    );
  }

  /** Draft -> challenge_issued: the scaffolded nonce path (see module doc) — optional, never required for the primary operator-review flow. */
  private async requestChallenge(claimId: string): Promise<void> {
    if (this.busyClaimId !== null) return;
    this.busyClaimId = claimId;
    this.claimActionError = withoutKey(this.claimActionError, claimId);
    const claim = await this.runClaimAction(
      claimId,
      `/api/account/builder-claims/${encodeURIComponent(claimId)}/challenge`,
      null,
    );
    if (claim !== null) this.applyUpdatedClaim(claim);
    this.busyClaimId = null;
  }

  private async submitProof(claimId: string): Promise<void> {
    if (this.busyClaimId !== null) return;
    const note = (this.proofDraftByClaimId[claimId] ?? "").trim();
    if (note === "") {
      this.claimActionError = {
        ...this.claimActionError,
        [claimId]: translateText("builder_claim.validation_error"),
      };
      return;
    }
    this.busyClaimId = claimId;
    this.claimActionError = withoutKey(this.claimActionError, claimId);
    const claim = await this.runClaimAction(
      claimId,
      `/api/account/builder-claims/${encodeURIComponent(claimId)}/proof`,
      { evidenceNote: note, evidenceLinks: [] },
    );
    if (claim !== null) {
      this.applyUpdatedClaim(claim);
      this.proofDraftByClaimId = withoutKey(this.proofDraftByClaimId, claimId);
    }
    this.busyClaimId = null;
  }

  private async withdrawClaim(claimId: string): Promise<void> {
    if (this.busyClaimId !== null) return;
    this.busyClaimId = claimId;
    this.withdrawConfirmClaimId = null;
    this.claimActionError = withoutKey(this.claimActionError, claimId);
    const claim = await this.runClaimAction(
      claimId,
      `/api/account/builder-claims/${encodeURIComponent(claimId)}/withdraw`,
      null,
    );
    if (claim !== null) this.applyUpdatedClaim(claim);
    this.busyClaimId = null;
  }

  private updateProofDraft(claimId: string, value: string): void {
    this.proofDraftByClaimId = { ...this.proofDraftByClaimId, [claimId]: value };
  }

  render() {
    return html`
      ${appShellHeader(null, undefined, this.accountUrl)}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 class="mb-2 text-xl font-bold text-ink">
          ${translateText("builder_claim.heading")}
        </h1>
        <p class="mb-6 text-sm text-ink-muted">
          ${translateText("builder_claim.intro")}
        </p>
        ${this.loadState === "loading" ? this.renderLoading() : nothing}
        ${this.loadState === "error" ? this.renderError() : nothing}
        ${this.loadState === "ready" ? this.renderReady() : nothing}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderLoading() {
    return html`<p class="text-sm text-ink-muted" role="status">
      ${translateText("builder_claim.loading")}
    </p>`;
  }

  private renderError() {
    return html`
      <div
        class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        role="alert"
      >
        ${translateText("builder_claim.load_error")}
        <button
          type="button"
          class="ml-2 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click=${() => this.load()}
        >
          ${translateText("builder_claim.retry")}
        </button>
      </div>
    `;
  }

  private renderReady() {
    if (this.identity === null || this.identity.githubLogin === null) {
      return this.renderSignInRequired();
    }
    return html`
      <p class="mb-4 text-xs text-ink-muted">
        ${translateText("builder_claim.signed_in_as", {
          login: this.identity.githubLogin,
        })}
      </p>
      ${this.submittedClaim !== null
        ? this.renderConfirmation(this.submittedClaim)
        : this.renderForm()}
      ${this.myClaims.length > 0 ? this.renderMyClaims() : nothing}
    `;
  }

  private renderSignInRequired() {
    return html`
      <div class="rounded-md border border-line bg-surface-2 px-4 py-3 text-sm">
        <p class="mb-2 font-semibold text-ink">
          ${translateText("builder_claim.signin_required_heading")}
        </p>
        <p class="mb-3 text-ink-muted">
          ${translateText("builder_claim.signin_required_body")}
        </p>
        <a
          href=${this.accountUrl}
          class="inline-block font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("builder_claim.signin_required_cta")}</a
        >
      </div>
    `;
  }

  private renderAgentPicker() {
    if (this.unclaimedAgents.length === 0) {
      return html`<p class="text-sm text-ink-muted">
        ${translateText("builder_claim.agent_picker_empty")}
      </p>`;
    }
    return html`
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-semibold text-ink"
          >${translateText("builder_claim.agent_picker_label")}</span
        >
        <select
          .value=${this.selectedAgentId}
          @change=${(event: Event) =>
            (this.selectedAgentId = (event.target as HTMLSelectElement).value)}
          class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          required
        >
          <option value="">
            ${translateText("builder_claim.agent_picker_placeholder")}
          </option>
          ${this.unclaimedAgents.map(
            (agent) =>
              html`<option value=${agent.id}>${agent.displayName}</option>`,
          )}
        </select>
      </label>
    `;
  }

  private renderForm() {
    const preselected =
      this.agentSlug !== ""
        ? this.unclaimedAgents.find((agent) => agent.slug === this.agentSlug) ??
          null
        : null;
    const agentNotClaimable = this.agentSlug !== "" && preselected === null;
    return html`
      <form
        class="mb-8 flex flex-col gap-4 rounded-md border border-line bg-surface-2 p-4"
        @submit=${(event: Event) => this.submitClaim(event)}
      >
        ${agentNotClaimable
          ? html`<p
              class="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 text-xs text-caution"
            >
              ${translateText("builder_claim.agent_not_claimable_body")}
            </p>`
          : nothing}
        ${preselected !== null
          ? html`<p class="text-sm text-ink">
              ${translateText("builder_claim.selected_agent_label")}:
              <span class="font-semibold">${preselected.displayName}</span>
              <a
                href="/claim"
                class="ml-2 text-xs font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
                >${translateText("builder_claim.change_agent_link")}</a
              >
            </p>`
          : this.renderAgentPicker()}
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold text-ink"
            >${translateText("builder_claim.player_name_label")}</span
          >
          <input
            type="text"
            .value=${this.claimedCoworldPlayerName}
            @input=${(event: InputEvent) =>
              (this.claimedCoworldPlayerName = (
                event.target as HTMLInputElement
              ).value)}
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            required
          />
          <span class="text-xs text-ink-muted"
            >${translateText("builder_claim.player_name_caution")}</span
          >
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold text-ink"
            >${translateText("builder_claim.display_name_label")}</span
          >
          <input
            type="text"
            .value=${this.builderDisplayName}
            @input=${(event: InputEvent) =>
              (this.builderDisplayName = (event.target as HTMLInputElement).value)}
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            required
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold text-ink"
            >${translateText("builder_claim.short_bio_label")}</span
          >
          <textarea
            .value=${this.builderShortBio}
            @input=${(event: InputEvent) =>
              (this.builderShortBio = (
                event.target as HTMLTextAreaElement
              ).value)}
            rows="2"
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold text-ink"
            >${translateText("builder_claim.links_label")}</span
          >
          <textarea
            .value=${this.builderLinksText}
            @input=${(event: InputEvent) =>
              (this.builderLinksText = (
                event.target as HTMLTextAreaElement
              ).value)}
            rows="2"
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
          <span class="text-xs text-ink-muted"
            >${translateText("builder_claim.links_hint")}</span
          >
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold text-ink"
            >${translateText("builder_claim.team_members_label")}</span
          >
          <textarea
            .value=${this.teamMembersText}
            @input=${(event: InputEvent) =>
              (this.teamMembersText = (
                event.target as HTMLTextAreaElement
              ).value)}
            rows="2"
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
          <span class="text-xs text-ink-muted"
            >${translateText("builder_claim.team_members_hint")}</span
          >
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold text-ink"
            >${translateText("builder_claim.evidence_note_label")}</span
          >
          <textarea
            .value=${this.evidenceNote}
            @input=${(event: InputEvent) =>
              (this.evidenceNote = (event.target as HTMLTextAreaElement).value)}
            rows="3"
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            required
          ></textarea>
          <span class="text-xs text-ink-muted"
            >${translateText("builder_claim.evidence_note_hint")}</span
          >
        </label>
        <label class="flex flex-col gap-1 text-sm">
          <span class="font-semibold text-ink"
            >${translateText("builder_claim.evidence_links_label")}</span
          >
          <textarea
            .value=${this.evidenceLinksText}
            @input=${(event: InputEvent) =>
              (this.evidenceLinksText = (
                event.target as HTMLTextAreaElement
              ).value)}
            rows="2"
            class="rounded border border-line bg-surface px-2 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
        </label>
        ${this.formError !== null
          ? html`<p class="text-sm text-danger" role="alert">
              ${this.formError}
            </p>`
          : nothing}
        ${this.submitError !== null
          ? html`<p class="text-sm text-danger" role="alert">
              ${this.submitError}
            </p>`
          : nothing}
        <button
          type="submit"
          ?disabled=${this.submitting}
          class="self-start rounded bg-accent px-4 py-2 text-sm font-bold text-white outline-none hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          ${this.submitting
            ? translateText("builder_claim.submitting_button")
            : translateText("builder_claim.submit_button")}
        </button>
      </form>
    `;
  }

  private renderConfirmation(claim: BuilderClaimRecord) {
    const badge = CLAIM_STATE_BADGE[claim.state];
    return html`
      <div
        class="mb-8 rounded-md border border-positive/40 bg-positive/10 px-4 py-3 text-sm text-ink"
      >
        <p class="mb-1 font-semibold">
          ${translateText("builder_claim.confirmation_heading")}
        </p>
        <p class="mb-2 text-ink-muted">
          ${translateText("builder_claim.confirmation_body")}
        </p>
        <p class="mb-3">
          ${translateText("builder_claim.confirmation_state_label")}:
          <span
            class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
            >${translateText(badge.labelKey)}</span
          >
        </p>
        <div class="flex flex-wrap gap-4">
          ${this.submittedAgentSlug !== null
            ? html`<a
                href="/agent/${encodeURIComponent(this.submittedAgentSlug)}"
                class="font-semibold text-accent no-underline outline-none hover:text-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
                >${translateText("builder_claim.view_agent_link")}</a
              >`
            : nothing}
          <button
            type="button"
            @click=${() => this.startAnotherClaim()}
            class="font-semibold text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            ${translateText("builder_claim.submit_another_link")}
          </button>
        </div>
      </div>
    `;
  }

  private renderMyClaims() {
    return html`
      <section aria-labelledby="builder-claim-my-claims-heading">
        <h2
          id="builder-claim-my-claims-heading"
          class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted"
        >
          ${translateText("builder_claim.my_claims_heading")}
        </h2>
        <ul class="flex flex-col gap-3" role="list">
          ${this.myClaims.map((claim) => this.renderClaimRow(claim))}
        </ul>
      </section>
    `;
  }

  private renderClaimRow(claim: BuilderClaimRecord): TemplateResult {
    const badge = CLAIM_STATE_BADGE[claim.state];
    const agent = this.agentsById.get(claim.agentId) ?? null;
    const label = agent?.displayName ?? claim.agentId;
    const actionable = NON_TERMINAL_STATES[claim.state];
    const busy = this.busyClaimId === claim.id;
    const actionError = this.claimActionError[claim.id];
    return html`
      <li class="rounded-md border border-line bg-surface-2 px-3 py-3 text-sm">
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="font-semibold text-ink">${label}</span>
          <span
            class="rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${badge.cls}"
            >${translateText(badge.labelKey)}</span
          >
          <span class="ml-auto text-xs text-ink-muted"
            >${translateText("builder_claim.updated_label")}:
            ${new Date(claim.updatedAt).toLocaleDateString()}</span
          >
        </div>
        ${claim.state === "draft" && claim.nonceChallenge === null
          ? html`
              <p class="mb-2 text-xs text-ink-muted">
                ${translateText("builder_claim.challenge_note")}
              </p>
              <button
                type="button"
                ?disabled=${busy}
                @click=${() => this.requestChallenge(claim.id)}
                class="mb-2 rounded border border-line px-2 py-1 text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                ${translateText("builder_claim.challenge_button")}
              </button>
            `
          : nothing}
        ${claim.nonceChallenge !== null
          ? html`
              <div
                class="mb-2 rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink-muted"
              >
                <p>
                  ${translateText("builder_claim.challenge_nonce_label")}:
                  <span class="font-mono text-ink"
                    >${claim.nonceChallenge.nonce}</span
                  >
                </p>
                <p class="mt-1">
                  ${translateText("builder_claim.challenge_instructions_label")}:
                  ${claim.nonceChallenge.instructions}
                </p>
              </div>
            `
          : nothing}
        ${actionable
          ? html`
              <div class="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder=${translateText("builder_claim.proof_note_label")}
                  .value=${this.proofDraftByClaimId[claim.id] ?? ""}
                  @input=${(event: InputEvent) =>
                    this.updateProofDraft(
                      claim.id,
                      (event.target as HTMLInputElement).value,
                    )}
                  class="min-w-[10rem] flex-1 rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                <button
                  type="button"
                  ?disabled=${busy}
                  @click=${() => this.submitProof(claim.id)}
                  class="rounded border border-line px-2 py-1 text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                >
                  ${translateText("builder_claim.proof_button")}
                </button>
                ${this.withdrawConfirmClaimId === claim.id
                  ? html`
                      <span class="text-xs text-danger"
                        >${translateText(
                          "builder_claim.withdraw_confirm_prompt",
                        )}</span
                      >
                      <button
                        type="button"
                        ?disabled=${busy}
                        @click=${() => this.withdrawClaim(claim.id)}
                        class="rounded border border-danger/50 px-2 py-1 text-xs font-semibold text-danger outline-none hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                      >
                        ${translateText("common.confirm")}
                      </button>
                      <button
                        type="button"
                        @click=${() => (this.withdrawConfirmClaimId = null)}
                        class="rounded border border-line px-2 py-1 text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        ${translateText("common.cancel")}
                      </button>
                    `
                  : html`
                      <button
                        type="button"
                        ?disabled=${busy}
                        @click=${() =>
                          (this.withdrawConfirmClaimId = claim.id)}
                        class="rounded border border-line px-2 py-1 text-xs font-semibold text-danger outline-none hover:bg-danger/10 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                      >
                        ${translateText("builder_claim.withdraw_button")}
                      </button>
                    `}
              </div>
            `
          : nothing}
        ${actionError !== undefined
          ? html`<p class="mt-2 text-xs text-danger" role="alert">
              ${actionError}
            </p>`
          : nothing}
      </li>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "builder-claim-page": BuilderClaimPage;
  }
}
