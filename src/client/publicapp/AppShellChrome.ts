import { html, nothing, TemplateResult } from "lit";
import { translateText } from "../Utils";

/**
 * Shared header/footer chrome for every Stage 2+ public page
 * (`/`, `/watch`, `/agents`, `/agent/:slug`, `/builders`, `/builder/:slug`,
 * `/about`) — spec Stage 2 item 2 ("App shell per §4... reuse Stage 0 tokens
 * and primitives"). Not a wrapping custom element: these pages fully replace
 * `document.body` (same pattern as `PlayerProfilePage`/`TraderProfilePage`),
 * so each page's own `render()` includes `appShellHeader()`/
 * `appShellFooter()` at the top/bottom of its own template instead of
 * nesting inside a shell element.
 *
 * Nav is four items, not the spec's five (`Watch · League · Agents ·
 * Builders · Build`): `/build` does not exist yet (Stage 7). Per the
 * overhaul instructions, a stub nav entry to a page that isn't built is a
 * dead tab, which is explicitly disallowed — `Build` is added when Stage 7
 * ships, not before. `/about` is a secondary link per spec §4 ("+
 * About/How it works..."), not one of the primary five, so it lives in the
 * footer, not the header nav.
 *
 * The brand mark reuses the EXACT existing treatment
 * (`CoworldLeagueSiteWriter.ts`'s `.mark` — a bordered "PW" glyph box) per
 * "do not redesign the logo": no `public/brand` asset exists in this repo
 * today, so the shipped text-mark IS the existing brand mark.
 */

export type AppShellRoute =
  | "/"
  | "/watch"
  | "/league"
  | "/agents"
  | "/builders"
  | "/about";

const NAV_ITEMS: ReadonlyArray<{
  route: AppShellRoute;
  labelKey: string;
  href: string;
}> = [
  { route: "/watch", labelKey: "app_shell.nav_watch", href: "/watch" },
  { route: "/league", labelKey: "app_shell.nav_league", href: "/league" },
  { route: "/agents", labelKey: "app_shell.nav_agents", href: "/agents" },
  {
    route: "/builders",
    labelKey: "app_shell.nav_builders",
    href: "/builders",
  },
];

export interface AppShellStatusChip {
  label: string;
  tone: "live" | "stale" | "neutral";
}

/**
 * @param active current route, for `aria-current` — `null` on a page with
 * no direct nav match (an `/agent/:slug` profile still highlights `Agents`,
 * passed explicitly by the caller).
 * @param statusChip optional live/premiere/stale status chip — omitted on
 * pages with nothing to report.
 */
export function appShellHeader(
  active: AppShellRoute | null,
  statusChip?: AppShellStatusChip,
): TemplateResult {
  return html`
    <header
      class="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur"
    >
      <a
        href="/"
        class="flex items-center gap-2 font-black text-ink no-underline outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          class="flex h-8 w-8 items-center justify-center rounded border border-line font-mono text-xs font-extrabold"
          aria-hidden="true"
          >PW</span
        >
        <span class="text-sm tracking-tight">PROXY WAR</span>
      </a>
      <nav
        aria-label=${translateText("app_shell.nav_primary")}
        class="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto"
      >
        ${NAV_ITEMS.map(
          (item) => html`
            <a
              href=${item.href}
              aria-current=${item.route === active ? "page" : nothing}
              class="rounded px-3 py-2 text-sm font-bold text-ink-muted no-underline outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent ${item.route ===
              active
                ? "text-ink underline decoration-accent decoration-2 underline-offset-4"
                : ""}"
              >${translateText(item.labelKey)}</a
            >
          `,
        )}
      </nav>
      <div class="flex items-center gap-2">
        ${statusChip !== undefined
          ? html`<span
              class="rounded-full border px-3 py-1 font-mono text-xs font-extrabold ${statusChip.tone ===
              "live"
                ? "border-live/60 text-live"
                : statusChip.tone === "stale"
                  ? "border-caution/50 text-caution"
                  : "border-line text-ink-muted"}"
              >${statusChip.label}</span
            >`
          : nothing}
      </div>
    </header>
  `;
}

export function appShellFooter(): TemplateResult {
  return html`
    <footer
      class="mt-10 border-t border-line px-4 py-6 text-xs text-ink-muted"
    >
      <div
        class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3"
      >
        <div class="flex flex-wrap items-center gap-3">
          <span>${translateText("app_shell.footer_tagline")}</span>
          <a
            href="https://github.com/0xNad/ProxyWar"
            class="font-semibold text-ink-muted underline decoration-line outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("app_shell.footer_repository")}</a
          >
          <a
            href="/about"
            class="font-semibold text-ink-muted underline decoration-line outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >${translateText("app_shell.footer_about")}</a
          >
        </div>
      </div>
    </footer>
  `;
}

/** Shared page-level wrapper classes — the light-DOM Tailwind pattern every `PublicPage`-style component uses (see `PlayerProfilePage.createRenderRoot`). */
export const APP_SHELL_ROOT_CLASSES = [
  "block",
  "min-h-screen",
  "w-full",
  "bg-surface",
  "text-ink",
] as const;
