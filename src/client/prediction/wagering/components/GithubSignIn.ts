import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { z } from "zod";

/**
 * Compact "Sign in with GitHub" control + "signed in as" indicator, mounted
 * in the betting overlay header. Talks to `/api/premieres/auth/github/*`
 * (see `ReplayPremiereGithubAuth.ts`) — the SAME signed guest cookie
 * identity as everything else under `/api/premieres`, never a second one.
 *
 * Cleanly absent — renders nothing — when the server reports the feature
 * unavailable (no `PROXYWAR_GITHUB_OAUTH_CLIENT_ID`/`_SECRET` configured):
 * `/status` responds non-200 in that case, and this component never shows
 * a button that would 404.
 *
 * The actual sign-in click is a plain `<a>` navigation, not a fetch: the
 * browser has to follow GitHub's redirect and come back, which only a
 * real top-level navigation can do.
 */
const identitySchema = z.object({
  signedIn: z.boolean(),
  login: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  canonicalParticipantId: z.string(),
});

const statusResponseSchema = z.object({
  schemaVersion: z.literal(1),
  csrfToken: z.string(),
  identity: identitySchema,
});

type GithubIdentity = z.infer<typeof identitySchema>;

const GITHUB_MARK_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";

@customElement("premiere-github-sign-in")
export class PremiereGithubSignIn extends LitElement {
  @state() private available = false;
  @state() private loading = true;
  @state() private identity: GithubIdentity | null = null;
  @state() private banner: "linked" | "error" | "active_trade" | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.consumeReturnBanner();
    void this.load();
  }

  /** Consumes the `?github=linked|error|active_trade` marker the callback redirect leaves on `/bet/<id>`, showing it once and scrubbing it from the URL so a reload doesn't repeat it. */
  private consumeReturnBanner(): void {
    const url = new URL(window.location.href);
    const marker = url.searchParams.get("github");
    if (marker !== "linked" && marker !== "error" && marker !== "active_trade") return;
    this.banner = marker;
    url.searchParams.delete("github");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch("/api/premieres/auth/github/status", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        this.available = false;
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const parsed = statusResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.available = false;
        return;
      }
      this.available = true;
      this.identity = parsed.data.identity;
    } catch {
      this.available = false;
    } finally {
      this.loading = false;
    }
  }

  render() {
    if (this.loading || !this.available) return html``;
    return html`
      ${this.banner !== null ? this.renderBanner() : nothing}
      ${this.identity?.signedIn ? this.renderSignedIn(this.identity) : this.renderSignIn()}
    `;
  }

  private renderSignIn() {
    return html`
      <a
        href="/api/premieres/auth/github/start"
        class="inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-1 text-[11px] font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path d=${GITHUB_MARK_PATH}></path>
        </svg>
        Sign in
      </a>
    `;
  }

  private renderSignedIn(identity: GithubIdentity) {
    return html`
      <span
        class="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-1 text-[11px] font-semibold text-ink"
        title="Signed in with GitHub as ${identity.login}"
      >
        ${identity.avatarUrl !== null
          ? html`<img
              src=${identity.avatarUrl}
              alt=""
              class="h-3 w-3 rounded-full"
            />`
          : html`<svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="currentColor"
              aria-hidden="true"
              class="text-ink-muted"
            >
              <path d=${GITHUB_MARK_PATH}></path>
            </svg>`}
        <span class="max-w-[7rem] truncate">${identity.login}</span>
      </span>
    `;
  }

  private renderBanner() {
    const tone =
      this.banner === "linked"
        ? "border-accent/40 bg-accent-soft text-accent-strong"
        : "border-danger/40 bg-danger/10 text-danger";
    const message =
      this.banner === "linked"
        ? "Signed in with GitHub."
        : this.banner === "active_trade"
          ? "You already have an open position this match — sign in before you trade, or after it settles."
          : "GitHub sign-in failed. Try again.";
    return html`
      <div
        role="status"
        class="pointer-events-none fixed inset-x-0 top-0 z-[54000] flex justify-center px-4 pt-2"
      >
        <p
          class="pointer-events-auto rounded-md border px-3 py-1.5 text-xs font-semibold shadow-lg ${tone}"
        >
          ${message}
        </p>
      </div>
    `;
  }
}
