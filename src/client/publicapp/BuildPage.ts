import { html, LitElement, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  APP_SHELL_ROOT_CLASSES,
  appShellFooter,
  appShellHeader,
  waitForTranslationsReady,
} from "./AppShellChrome";
import { translateText } from "../Utils";
import { analytics } from "../analytics/AnalyticsClient";

/**
 * MUST stay in sync with `BuildRegistrationSubmission.ts`'s `claimedGithub`
 * Zod schema (`/^[a-zA-Z0-9-]{1,39}$/`) — validating client-side against a
 * different pattern than the server enforces would let a value pass here
 * and still 400 on submit, or reject something the server would accept.
 * Checked BEFORE the network round-trip so a bad value (e.g. a space, which
 * a person might type from a display name instead of a bare username) never
 * has to wait on a fetch to learn it's wrong (2026-08-01 P1 fix — this field
 * previously failed server-side with no field indication at all, just the
 * generic "Couldn't generate the submission" banner).
 */
const GITHUB_USERNAME_PATTERN = /^[a-zA-Z0-9-]{1,39}$/;

/** `null` (valid) unless a non-empty, non-username-shaped value was entered — the field is optional, so an empty value is always valid. */
function validateClaimedGithub(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return GITHUB_USERNAME_PATTERN.test(trimmed)
    ? null
    : translateText("build_page.step3.github_error_format");
}

/**
 * `/build` — spec Stage 7 item 1: "a visitor becomes a competing builder
 * without leaving `/build` until they genuinely need Softmax." Seven-step
 * guided flow, UNIFYING the existing paths rather than forking them:
 *
 * 1. Object model (Builder / Agent / Version) in plain language.
 * 2. Path choice — links to the ONE canonical starter repo
 *    (`proxywar-coworld-starter`), never a forked copy.
 * 3. Identity — generates a validated registration DRAFT (never an instant
 *    publish; see `BuildRegistrationSubmission.ts`'s doc for why).
 * 4. Run locally — exact `coworld run-episode --verify-replay` +
 *    STRATEGY/buildState/choose editing, verified against the starter's
 *    actual source (`llm-player.mjs`/`starter-player.mjs`) and
 *    `coworld-adapter/ENTER_THE_LEAGUE.md`; also links the full
 *    `player-protocol.md` decision-contract reference that Step 2's
 *    bring-your-own-policy option promises.
 * 5. Upload and enter — the real `launch.sh` + `coworld upload-policy` /
 *    `coworld leagues` / `coworld submit` sequence.
 * 6. Verify — a checklist an entrant can actually act on; the backstage
 *    `identity:list-unmapped` check is described honestly (it's a repo-only
 *    CI script, not something a builder without repo access can run).
 * 7. Improve — where results/feedback live, next-version workflow.
 *
 * Step 2 used to also point at a SEPARATE `/agent-start` relay/Agent-Card
 * exhibition path; that route now 404s on the live app router (it only still
 * exists under the historical `ai-agent-demo-server.ts`, marked
 * maintenance-only in AGENTS.md), so the callout was removed rather than
 * left pointing at a dead link (2026-08-02).
 */
@customElement("build-page")
export class BuildPage extends LitElement {
  @state() private step = 1;

  @state() private agentName = "";
  @state() private shortCode = "";
  @state() private tagline = "";
  @state() private publicStrategyDescription = "";
  @state() private builderDisplayName = "";
  @state() private builderShortBio = "";
  @state() private builderLinksText = "";
  @state() private teamMembersText = "";
  @state() private claimedGithub = "";
  @state() private sourceRepositoryRef = "";

  @state() private emblemPreviewSvg: string | null = null;
  @state() private emblemPreviewColors: {
    primary: string;
    secondary: string;
  } | null = null;
  private emblemPreviewTimer: ReturnType<typeof setTimeout> | null = null;

  @state() private submitting = false;
  @state() private submitError: string | null = null;
  /** Field-level, shown inline under the GitHub-username input — distinct from `submitError`'s generic banner (2026-08-01 P1 fix). Set by client-side validation on input/submit, or by the server's `{field: "claimedGithub", reason}` 400 payload if it somehow gets past that. */
  @state() private githubUsernameError: string | null = null;
  @state() private submissionResult: {
    profileFileJson: string;
    githubIssueUrl: string;
  } | null = null;

  @state() private copiedKey: string | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly reportedSteps = new Set<number>();

  createRenderRoot() {
    this.classList.add(...APP_SHELL_ROOT_CLASSES);
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.reportStep(this.step);
    void waitForTranslationsReady().then(() => this.requestUpdate());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.emblemPreviewTimer !== null) clearTimeout(this.emblemPreviewTimer);
    if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
  }

  /** Fire-and-forget, silent — spec Stage 7 item 4 ("collect, don't gate"). Never awaited, never surfaced to the visitor, never blocks a step transition. */
  private reportStep(step: number): void {
    if (this.reportedSteps.has(step)) return;
    this.reportedSteps.add(step);
    if (step === 1) {
      analytics.track("build_flow_started");
    }
    analytics.track("build_step_reached", { step });
  }

  private goToStep(step: number): void {
    this.step = step;
    this.reportStep(step);
    if (typeof this.scrollIntoView === "function") {
      this.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  private slugPreviewFor(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
  }

  private onAgentNameInput(event: Event): void {
    this.agentName = (event.target as HTMLInputElement).value;
    if (this.emblemPreviewTimer !== null) clearTimeout(this.emblemPreviewTimer);
    this.emblemPreviewTimer = setTimeout(() => {
      void this.loadEmblemPreview();
    }, 300);
  }

  private async loadEmblemPreview(): Promise<void> {
    const slug = this.slugPreviewFor(this.agentName);
    if (slug === "") {
      this.emblemPreviewSvg = null;
      this.emblemPreviewColors = null;
      return;
    }
    try {
      const response = await fetch(
        `/api/build/emblem-preview?slug=${encodeURIComponent(slug)}`,
      );
      if (!response.ok) return;
      const body = (await response.json()) as {
        ok: boolean;
        svg?: string;
        primaryColor?: string;
        secondaryColor?: string;
      };
      if (!body.ok || body.svg === undefined) return;
      this.emblemPreviewSvg = body.svg;
      this.emblemPreviewColors =
        body.primaryColor !== undefined && body.secondaryColor !== undefined
          ? { primary: body.primaryColor, secondary: body.secondaryColor }
          : null;
    } catch {
      // Live preview is polish only — the submission itself derives the
      // same values server-side regardless of whether this fetch succeeds.
    }
  }

  private async submitRegistration(): Promise<void> {
    this.submitting = true;
    this.submitError = null;
    // Client-side gate: catches the exact failure the server would 400 on
    // (2026-08-01 P1 fix) WITHOUT a network round-trip, and shows it inline
    // under the field rather than as a generic banner.
    const githubError = validateClaimedGithub(this.claimedGithub);
    if (githubError !== null) {
      this.githubUsernameError = githubError;
      this.submitting = false;
      return;
    }
    this.githubUsernameError = null;
    try {
      const response = await fetch("/api/build/registration-submission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName: this.agentName.trim(),
          shortCode: this.shortCode.trim().toUpperCase(),
          tagline: this.tagline.trim() === "" ? null : this.tagline.trim(),
          publicStrategyDescription:
            this.publicStrategyDescription.trim() === ""
              ? null
              : this.publicStrategyDescription.trim(),
          builderDisplayName: this.builderDisplayName.trim(),
          builderShortBio:
            this.builderShortBio.trim() === ""
              ? null
              : this.builderShortBio.trim(),
          builderLinks: this.builderLinksText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== ""),
          teamMembers: this.teamMembersText
            .split(",")
            .map((name) => name.trim())
            .filter((name) => name !== ""),
          claimedGithub:
            this.claimedGithub.trim() === "" ? null : this.claimedGithub.trim(),
          sourceRepositoryRef:
            this.sourceRepositoryRef.trim() === ""
              ? null
              : this.sourceRepositoryRef.trim(),
        }),
      });
      const body = (await response.json()) as {
        ok: boolean;
        profileFileJson?: string;
        githubIssueUrl?: string;
        field?: string;
        reason?: string;
      };
      if (
        !response.ok ||
        !body.ok ||
        body.profileFileJson === undefined ||
        body.githubIssueUrl === undefined
      ) {
        // Defense in depth: if the server still rejects `claimedGithub`
        // despite the client-side gate above (e.g. a future server-only
        // rule), show it inline on that field instead of falling through
        // to the generic banner.
        if (body.field === "claimedGithub") {
          this.githubUsernameError = translateText(
            "build_page.step3.github_error_format",
          );
        } else {
          this.submitError = translateText("build_page.step3.submit_error");
        }
        return;
      }
      this.submissionResult = {
        profileFileJson: body.profileFileJson,
        githubIssueUrl: body.githubIssueUrl,
      };
      analytics.track("registration_draft_submitted");
    } catch {
      this.submitError = translateText("build_page.step3.submit_error");
    } finally {
      this.submitting = false;
    }
  }

  private async copyToClipboard(text: string, key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copiedKey = key;
      if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.copiedKey = null;
      }, 2000);
    } catch {
      // Clipboard permission denied — the command block stays selectable
      // text either way, so this is silent degradation, not a dead end.
    }
  }

  private renderCopyBlock(command: string, key: string): TemplateResult {
    return html`
      <div
        class="relative mt-2 overflow-x-auto rounded-md border border-line bg-surface-2 p-3 pr-16 font-mono text-xs text-ink"
      >
        <pre class="whitespace-pre-wrap break-all">${command}</pre>
        <button
          type="button"
          @click=${() => void this.copyToClipboard(command, key)}
          class="absolute right-2 top-2 rounded border border-line bg-surface px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-ink-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
        >
          ${this.copiedKey === key
            ? translateText("build_page.copied")
            : translateText("common.copy")}
        </button>
      </div>
    `;
  }

  render() {
    return html`
      ${appShellHeader("/build")}
      <main class="mx-auto w-full max-w-3xl px-4 py-8">
        <header class="mb-6">
          <p
            class="text-xs font-bold uppercase tracking-widest text-cyan-400"
          >
            ${translateText("build_page.eyebrow")}
          </p>
          <h1 class="mt-1 text-3xl font-black text-ink">
            ${translateText("build_page.title")}
          </h1>
          <p class="mt-2 max-w-2xl text-sm text-ink-muted">
            ${translateText("build_page.subtitle")}
          </p>
        </header>
        ${this.renderStepper()}
        <div class="mt-6 rounded-lg border border-line bg-surface p-5">
          ${this.renderCurrentStep()}
        </div>
        ${this.renderStepNav()}
      </main>
      ${appShellFooter()}
    `;
  }

  private renderStepper(): TemplateResult {
    const labels = [
      "build_page.step1.nav_label",
      "build_page.step2.nav_label",
      "build_page.step3.nav_label",
      "build_page.step4.nav_label",
      "build_page.step5.nav_label",
      "build_page.step6.nav_label",
      "build_page.step7.nav_label",
    ];
    return html`
      <ol class="flex flex-wrap gap-2" aria-label=${translateText(
        "build_page.stepper_label",
      )}>
        ${labels.map(
          (labelKey, index) => html`
            <li>
              <button
                type="button"
                @click=${() => this.goToStep(index + 1)}
                aria-current=${this.step === index + 1 ? "step" : "false"}
                class="rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${this
                  .step === index + 1
                  ? "border-accent bg-accent/10 text-accent"
                  : this.step > index + 1
                    ? "border-line text-ink-muted hover:text-ink"
                    : "border-line/60 text-ink-muted/75 hover:text-ink-muted"}"
              >
                ${index + 1}. ${translateText(labelKey)}
              </button>
            </li>
          `,
        )}
      </ol>
    `;
  }

  private renderStepNav(): TemplateResult {
    return html`
      <div class="mt-6 flex items-center justify-between">
        <button
          type="button"
          ?disabled=${this.step === 1}
          @click=${() => this.goToStep(this.step - 1)}
          class="rounded px-4 py-2 text-sm font-bold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30"
        >
          ${translateText("common.back")}
        </button>
        <button
          type="button"
          ?disabled=${this.step === 7}
          @click=${() => this.goToStep(this.step + 1)}
          class="rounded-md border border-accent bg-accent/10 px-4 py-2 text-sm font-bold text-accent outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30"
        >
          ${translateText("build_page.next_step")}
        </button>
      </div>
    `;
  }

  private renderCurrentStep(): TemplateResult {
    switch (this.step) {
      case 1:
        return this.renderStep1();
      case 2:
        return this.renderStep2();
      case 3:
        return this.renderStep3();
      case 4:
        return this.renderStep4();
      case 5:
        return this.renderStep5();
      case 6:
        return this.renderStep6();
      default:
        return this.renderStep7();
    }
  }

  private renderStep1(): TemplateResult {
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step1.heading")}
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step1.intro")}
      </p>
      <div class="mt-4 space-y-3">
        <div class="rounded-md border border-line bg-surface-2 p-4">
          <p class="text-sm font-bold text-ink">
            ${translateText("build_page.step1.builder_term")}
          </p>
          <p class="mt-1 text-xs text-ink-muted">
            ${translateText("build_page.step1.builder_desc")}
          </p>
        </div>
        <div class="ml-4 rounded-md border border-line bg-surface-2 p-4">
          <p class="text-sm font-bold text-ink">
            ${translateText("build_page.step1.agent_term")}
          </p>
          <p class="mt-1 text-xs text-ink-muted">
            ${translateText("build_page.step1.agent_desc")}
          </p>
        </div>
        <div class="ml-8 rounded-md border border-line bg-surface-2 p-4">
          <p class="text-sm font-bold text-ink">
            ${translateText("build_page.step1.version_term")}
          </p>
          <p class="mt-1 text-xs text-ink-muted">
            ${translateText("build_page.step1.version_desc")}
          </p>
        </div>
      </div>
    `;
  }

  private renderStep2(): TemplateResult {
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step2.heading")}
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step2.intro")}
      </p>
      <div class="mt-4 grid gap-3 sm:grid-cols-1">
        <div class="rounded-md border border-line bg-surface-2 p-4">
          <p class="text-sm font-bold text-ink">
            ${translateText("build_page.step2.llm_title")}
          </p>
          <p class="mt-1 text-xs text-ink-muted">
            ${translateText("build_page.step2.llm_desc")}
          </p>
          ${this.renderCopyBlock(
            "git clone https://github.com/0xNad/proxywar-coworld-starter.git\ncd proxywar-coworld-starter",
            "step2-llm-clone",
          )}
        </div>
        <div class="rounded-md border border-line bg-surface-2 p-4">
          <p class="text-sm font-bold text-ink">
            ${translateText("build_page.step2.rule_title")}
          </p>
          <p class="mt-1 text-xs text-ink-muted">
            ${translateText("build_page.step2.rule_desc")}
          </p>
        </div>
        <div class="rounded-md border border-line bg-surface-2 p-4">
          <p class="text-sm font-bold text-ink">
            ${translateText("build_page.step2.byo_title")}
          </p>
          <p class="mt-1 text-xs text-ink-muted">
            ${translateText("build_page.step2.byo_desc")}
          </p>
        </div>
      </div>
    `;
  }

  private renderStep3(): TemplateResult {
    if (this.submissionResult !== null) {
      return this.renderStep3Result(this.submissionResult);
    }
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step3.heading")}
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step3.intro")}
      </p>
      <form
        class="mt-4 space-y-4"
        @submit=${(event: Event) => {
          event.preventDefault();
          void this.submitRegistration();
        }}
      >
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
            ${translateText("build_page.step3.agent_name_label")}
            <input
              required
              maxlength="80"
              .value=${this.agentName}
              @input=${(event: Event) => this.onAgentNameInput(event)}
              class="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
          <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
            ${translateText("build_page.step3.short_code_label")}
            <input
              required
              maxlength="4"
              .value=${this.shortCode}
              @input=${(event: Event) =>
                (this.shortCode = (event.target as HTMLInputElement).value)}
              class="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm uppercase text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
        </div>
        ${this.emblemPreviewSvg !== null
          ? html`
              <div class="flex items-center gap-3">
                <div
                  class="h-16 w-16 shrink-0 rounded-md border border-line bg-surface-2 p-1"
                  .innerHTML=${this.emblemPreviewSvg}
                ></div>
                <p class="text-xs text-ink-muted">
                  ${translateText("build_page.step3.emblem_note")}
                  ${this.emblemPreviewColors !== null
                    ? html`<span
                          class="ml-1 inline-block h-3 w-3 rounded-full align-middle"
                          style="background-color:${this.emblemPreviewColors
                            .primary}"
                        ></span
                        ><span
                          class="ml-1 inline-block h-3 w-3 rounded-full align-middle"
                          style="background-color:${this.emblemPreviewColors
                            .secondary}"
                        ></span>`
                    : nothing}
                </p>
              </div>
            `
          : nothing}
        <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
          ${translateText("build_page.step3.tagline_label")}
          <input
            maxlength="120"
            .value=${this.tagline}
            @input=${(event: Event) =>
              (this.tagline = (event.target as HTMLInputElement).value)}
            class="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
          ${translateText("build_page.step3.strategy_desc_label")}
          <textarea
            rows="3"
            maxlength="2000"
            .value=${this.publicStrategyDescription}
            @input=${(event: Event) =>
              (this.publicStrategyDescription = (
                event.target as HTMLTextAreaElement
              ).value)}
            class="mt-1 w-full resize-none rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
        </label>
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
            ${translateText("build_page.step3.builder_name_label")}
            <input
              required
              maxlength="80"
              .value=${this.builderDisplayName}
              @input=${(event: Event) =>
                (this.builderDisplayName = (
                  event.target as HTMLInputElement
                ).value)}
              class="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </label>
          <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
            ${translateText("build_page.step3.github_label")}
            <input
              maxlength="39"
              .value=${this.claimedGithub}
              aria-invalid=${this.githubUsernameError !== null ? "true" : "false"}
              aria-describedby=${this.githubUsernameError !== null
                ? "build-step3-github-error"
                : nothing}
              @input=${(event: Event) => {
                this.claimedGithub = (event.target as HTMLInputElement).value;
                this.githubUsernameError = validateClaimedGithub(
                  this.claimedGithub,
                );
              }}
              class="mt-1 w-full rounded-md border ${this
                .githubUsernameError !== null
                ? "border-danger"
                : "border-line"} bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            ${this.githubUsernameError !== null
              ? html`<span
                  id="build-step3-github-error"
                  role="alert"
                  class="mt-1 block text-xs font-normal normal-case tracking-normal text-danger"
                  >${this.githubUsernameError}</span
                >`
              : nothing}
          </label>
        </div>
        <p class="text-xs text-ink-muted">
          ${translateText("build_page.step3.github_note")}
        </p>
        <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
          ${translateText("build_page.step3.builder_bio_label")}
          <textarea
            rows="2"
            maxlength="280"
            .value=${this.builderShortBio}
            @input=${(event: Event) =>
              (this.builderShortBio = (
                event.target as HTMLTextAreaElement
              ).value)}
            class="mt-1 w-full resize-none rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
        </label>
        <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
          ${translateText("build_page.step3.links_label")}
          <textarea
            rows="2"
            .value=${this.builderLinksText}
            @input=${(event: Event) =>
              (this.builderLinksText = (
                event.target as HTMLTextAreaElement
              ).value)}
            placeholder="https://..."
            class="mt-1 w-full resize-none rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          ></textarea>
        </label>
        <label class="block text-xs font-bold uppercase tracking-wide text-ink-muted">
          ${translateText("build_page.step3.repo_label")}
          <input
            .value=${this.sourceRepositoryRef}
            @input=${(event: Event) =>
              (this.sourceRepositoryRef = (
                event.target as HTMLInputElement
              ).value)}
            placeholder="https://github.com/..."
            class="mt-1 w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        ${this.submitError !== null
          ? html`<div
              role="alert"
              class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              ${this.submitError}
            </div>`
          : nothing}
        <button
          type="submit"
          ?disabled=${this.submitting}
          class="w-full rounded-md border border-accent bg-accent/10 px-4 py-2.5 text-sm font-bold text-accent outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          ${this.submitting
            ? translateText("build_page.step3.submitting")
            : translateText("build_page.step3.generate_submission")}
        </button>
      </form>
    `;
  }

  private renderStep3Result(result: {
    profileFileJson: string;
    githubIssueUrl: string;
  }): TemplateResult {
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step3.result_heading")}
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step3.result_intro")}
      </p>
      ${this.renderCopyBlock(result.profileFileJson, "step3-profile-json")}
      <a
        href=${result.githubIssueUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="mt-4 inline-block rounded-md border border-accent bg-accent/10 px-4 py-2.5 text-sm font-bold text-accent outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent"
      >
        ${translateText("build_page.step3.open_issue_cta")}
      </a>
      <p class="mt-3 text-xs text-ink-muted">
        ${translateText("build_page.step3.result_note")}
      </p>
      <button
        type="button"
        @click=${() => {
          this.submissionResult = null;
        }}
        class="mt-4 block text-xs font-bold uppercase tracking-wide text-ink-muted underline outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
      >
        ${translateText("build_page.step3.edit_again")}
      </button>
    `;
  }

  /**
   * P0 fix (found live 2026-08-02): this step used to introduce the
   * coworld CLI (list/run-episode) with no explanation of how it relates
   * to Step 5's launch.sh — two parallel toolchains, no cross-reference.
   * `toolchain_note` names the relationship explicitly (this is Softmax's
   * own coworld CLI, a lower-level/advanced tool launch.sh wraps
   * internally — confirmed against `coworld-adapter/ENTER_THE_LEAGUE.md`
   * and `tester-starter-llm/launch.sh`'s own `coworld upload-policy`
   * call). The sign-in command also moved here from Step 5: `coworld
   * list`/`run-episode` need it directly, while launch.sh signs itself in
   * and never did.
   */
  private renderStep4(): TemplateResult {
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step4.heading")}
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step4.prereqs")}
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step4.toolchain_note")}
      </p>
      <p class="mt-4 text-sm text-ink-muted">
        ${translateText("build_page.step4.sign_in")}
      </p>
      ${this.renderCopyBlock(
        "uvx --from softmax-cli softmax login",
        "step4-login",
      )}
      <p class="mt-4 text-sm font-bold text-ink">
        ${translateText("build_page.step4.find_coworld_id")}
      </p>
      ${this.renderCopyBlock("uvx --from coworld coworld list", "step4-list")}
      <p class="mt-4 text-sm font-bold text-ink">
        ${translateText("build_page.step4.run_locally_title")}
      </p>
      ${this.renderCopyBlock(
        "uvx --from coworld coworld run-episode <coworld-id> --verify-replay",
        "step4-run-episode",
      )}
      <p class="mt-2 text-xs text-ink-muted">
        ${translateText("build_page.step4.verify_replay_note")}
      </p>
      <p class="mt-4 text-sm font-bold text-ink">
        ${translateText("build_page.step4.editing_title")}
      </p>
      <p class="mt-1 text-xs text-ink-muted">
        ${translateText("build_page.step4.editing_llm")}
      </p>
      <p class="mt-2 text-xs text-ink-muted">
        ${translateText("build_page.step4.editing_rule")}
      </p>
      <p class="mt-4 text-sm font-bold text-ink">
        ${translateText("build_page.step4.contract_title")}
      </p>
      <p class="mt-1 text-xs text-ink-muted">
        ${translateText("build_page.step4.contract_desc")}
      </p>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-muted">
        <li>${translateText("build_page.step4.contract_timeout")}</li>
        <li>${translateText("build_page.step4.contract_degradation")}</li>
      </ul>
      <p class="mt-4 text-xs text-ink-muted">
        ${translateText("build_page.step4.protocol_reference_prefix")}
        <a
          href="https://github.com/0xNad/ProxyWar/blob/main/coworld-adapter/docs/player-protocol.md"
          target="_blank"
          rel="noopener noreferrer"
          class="text-cyan-400 underline outline-none hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("build_page.step4.protocol_reference_link")}</a
        >.
      </p>
    `;
  }

  private renderStep5(): TemplateResult {
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step5.heading")}
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step5.launch_intro")}
      </p>
      ${this.renderCopyBlock(
        "git clone https://github.com/0xNad/proxywar-coworld-starter.git\ncd proxywar-coworld-starter\nbash launch.sh my-agent",
        "step5-launch",
      )}
      <p class="mt-2 text-xs text-ink-muted">
        ${translateText("build_page.step5.launch_note")}
      </p>
      <p class="mt-4 text-sm font-bold text-ink">
        ${translateText("build_page.step5.enter_title")}
      </p>
      <p class="mt-1 text-xs text-ink-muted">
        ${translateText("build_page.step5.enter_toolchain_note")}
      </p>
      ${this.renderCopyBlock(
        "uvx --from coworld coworld leagues        # find the Proxywar row",
        "step5-leagues",
      )}
      ${this.renderCopyBlock(
        "uvx --from coworld coworld submit my-agent:v1 --league <league_id>",
        "step5-submit",
      )}
      <p class="mt-2 text-xs text-ink-muted">
        ${translateText("build_page.step5.graduation_note")}
      </p>
    `;
  }

  private renderStep6(): TemplateResult {
    const remainingItems = [
      "build_page.step6.result_valid",
      "build_page.step6.qualifier_passed",
      "build_page.step6.profile_mapped",
    ];
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step6.heading")}
      </h2>
      <ul class="mt-3 space-y-2 text-sm text-ink-muted">
        <li class="flex items-start gap-2">
          <span class="mt-0.5 text-accent">&#9633;</span>
          <span>${translateText("build_page.step6.image_uploaded")}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-0.5 text-accent">&#9633;</span>
          <span>${translateText("build_page.step6.policy_connects")}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-0.5 text-accent">&#9633;</span>
          <span>${translateText("build_page.step6.legal_decision")}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-0.5 text-accent">&#9633;</span>
          <span>${translateText("build_page.step6.no_crash")}</span>
        </li>
        <li class="flex items-start gap-2">
          <span class="mt-0.5 text-accent">&#9633;</span>
          <span
            >${translateText("build_page.step6.replay_produced_prefix")}
            <a
              href="https://softmax.com/observatory"
              target="_blank"
              rel="noopener noreferrer"
              class="text-cyan-400 underline outline-none hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-accent"
              >softmax.com/observatory</a
            >.</span
          >
        </li>
        ${remainingItems.map(
          (key) => html`
            <li class="flex items-start gap-2">
              <span class="mt-0.5 text-accent">&#9633;</span>
              <span>${translateText(key)}</span>
            </li>
          `,
        )}
      </ul>
      <p class="mt-4 rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-muted">
        ${translateText("build_page.step6.mapping_explainer")}
      </p>
    `;
  }

  /**
   * P0 fix (found live 2026-08-02): "softmax.com/observatory" used to
   * appear as bare unlinked text on both this step and Step 6, with no
   * explanation of what it is or how it relates to ProxyWar. Now a real
   * link, plus one sentence naming the relationship: Observatory is
   * Softmax's own hosting console (raw per-decision logs/scores);
   * ProxyWar surfaces the public league identity built on top of it.
   */
  private renderStep7(): TemplateResult {
    return html`
      <h2 class="text-lg font-bold text-ink">
        ${translateText("build_page.step7.heading")}
      </h2>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step7.replays_prefix")}
        <a
          href="https://softmax.com/observatory"
          target="_blank"
          rel="noopener noreferrer"
          class="text-cyan-400 underline outline-none hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-accent"
          >softmax.com/observatory</a
        >.
      </p>
      <p class="mt-2 text-xs text-ink-muted">
        ${translateText("build_page.step7.observatory_explainer")}
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step7.results")}
        <a
          href="/agents"
          class="text-cyan-400 underline outline-none hover:text-cyan-300 focus-visible:ring-2 focus-visible:ring-accent"
          >${translateText("build_page.step7.agents_link")}</a
        >.
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        ${translateText("build_page.step7.feedback")}
      </p>
      <p class="mt-4 rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-muted">
        ${translateText("build_page.step7.next_version")}
      </p>
    `;
  }
}
