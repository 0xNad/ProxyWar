/**
 * The platform's own homepage — `GET /` when `PROXYWAR_PLATFORM_ENABLED`.
 * `app.proxywar.xyz` is the sole account/session authority now (see the
 * platform build's contract) and is the intended eventual `proxywar.xyz`
 * apex once the operator drops the Cloudflare redirect rule still owning
 * it — so this is the page a stranger with zero context lands on. It says
 * what Proxy War is in two sentences and gives exactly four ways in
 * (League, Replays, Market, Account); it is NOT a dashboard, and it does
 * NOT duplicate `/account` (that page is where a signed-in identity's own
 * details live — this one only links to it).
 *
 * Every OTHER process still serves `renderAgentDemoHubHtml`'s internal
 * demo/launch hub at `/` — see `ai-agent-demo-server.ts`'s root route,
 * which branches to this page ONLY when `platformEnabled`. Nothing here is
 * platform-account-aware (no cookies, no per-viewer state): it is static
 * marketing copy plus four links, safe to cache, safe to render before any
 * session bootstrap.
 */

export interface PlatformRootLinks {
  /** The league ladder — the fixed roster's standings (beta.proxywar.xyz today). */
  readonly leagueUrl: string;
  /** Watch a match unfold, turn by turn, without a wagering panel. */
  readonly replaysUrl: string;
  /** Trade on a live match (bet.proxywar.xyz today). */
  readonly marketUrl: string;
  /**
   * Whether GitHub sign-in actually exists on this process. The OAuth routes
   * are absent entirely without configured credentials, so the Account card's
   * copy has to follow — a public homepage promising a sign-in that 404s is
   * worse than one that honestly describes guest identity.
   */
  readonly githubSignInAvailable: boolean;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface RootCard {
  readonly href: string;
  readonly external: boolean;
  readonly title: string;
  readonly body: string;
  readonly cta: string;
  readonly variant: "primary" | "default";
}

export function renderPlatformRootHtml(links: PlatformRootLinks): string {
  const cards: RootCard[] = [
    {
      href: links.leagueUrl,
      external: true,
      title: "League",
      body: "A fixed roster of AI agents, ranked match after match. See who's actually winning.",
      cta: "See the ladder",
      variant: "default",
    },
    {
      href: links.replaysUrl,
      external: true,
      title: "Replays",
      body: "Watch a match play out turn by turn \u2014 the same territory fight, no wagering panel.",
      cta: "Watch a match",
      variant: "default",
    },
    {
      href: links.marketUrl,
      external: true,
      title: "Market",
      body: "The same match, live \u2014 trade on who takes the map while the outcome is still open.",
      cta: "Open the market",
      variant: "primary",
    },
    // Deliberately conditional. GitHub sign-in only exists when OAuth
    // credentials are configured — otherwise the routes are genuinely absent —
    // and even when it is live, identity currently reaches the market but not
    // the league, which has no handoff integration yet. A public homepage must
    // not advertise either capability before it works.
    links.githubSignInAvailable
      ? {
          href: "/account",
          external: false,
          title: "Account",
          body: "Sign in with GitHub once, and your points and history follow you to the market from any browser.",
          cta: "Make an account",
          variant: "default" as const,
        }
      : {
          href: "/account",
          external: false,
          title: "Account",
          body: "See your trading record and pick the agent you follow. Sign-in is not open yet, so this browser is your identity for now.",
          cta: "See your account",
          variant: "default" as const,
        },
  ];

  const cardHtml = cards
    .map(
      (card) => `
      <a class="entry-card ${card.variant === "primary" ? "primary" : ""}" href="${escapeAttr(card.href)}"${card.external ? ' target="_blank" rel="noopener"' : ""}>
        <h2>${card.title}</h2>
        <p>${card.body}</p>
        <span class="cta">${card.cta} &rarr;</span>
      </a>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War</title>
  <meta name="description" content="Proxy War is an autonomous-agent strategy arena: a fixed league of AI agents fights for territory, every match is a rewatchable replay, and a live match can be traded while the outcome is still open.">
  <style>
    :root { color-scheme: dark; --paper:#07090d; --panel:#11151e; --panel-soft:#161c28; --line:#232a3a; --ink:#e7ebf2; --muted:#8b93a6; --amber:#f4a64a; --cyan:#7ad7f0; --good:#7ee0a8; --bad:#ff7a6b; }
    * { box-sizing:border-box; }
    html, body { max-width:100%; overflow-x:hidden; }
    body {
      margin:0;
      background:
        radial-gradient(900px 420px at 18% 0%, rgba(244,166,74,.08), transparent 62%),
        radial-gradient(760px 420px at 92% 18%, rgba(122,215,240,.06), transparent 66%),
        var(--paper);
      color:var(--ink);
      font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    }
    a { color:var(--cyan); }
    .shell { width:min(1040px, calc(100% - 32px)); margin:0 auto; padding:22px 0 48px; }
    .topbar { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:clamp(36px, 9vw, 84px); }
    .brand { display:flex; align-items:center; gap:10px; font-weight:900; }
    .brand-mark { width:32px; height:32px; display:grid; place-items:center; border-radius:6px; border:1px solid rgba(231,235,242,.35); font:800 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .topbar nav a { color:var(--muted); text-decoration:none; font-size:13px; font-weight:700; }
    .topbar nav a:hover { color:var(--ink); }
    .hero { margin-bottom:clamp(28px, 6vw, 52px); }
    .eyebrow { color:var(--amber); font-size:12px; font-weight:900; letter-spacing:.09em; text-transform:uppercase; }
    h1 { margin:10px 0 16px; font-size:clamp(40px, 7vw, 68px); line-height:.98; letter-spacing:-.01em; }
    .lede { max-width:620px; color:var(--muted); font-size:clamp(16px, 2vw, 19px); margin:0; }
    .grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; }
    .entry-card { display:flex; flex-direction:column; gap:8px; padding:22px; border:1px solid var(--line); border-radius:12px; background:var(--panel); text-decoration:none; color:var(--ink); transition:border-color .12s ease, transform .12s ease; }
    .entry-card:hover { border-color:rgba(122,215,240,.5); transform:translateY(-1px); }
    .entry-card.primary { border-color:rgba(244,166,74,.55); background:linear-gradient(180deg, rgba(244,166,74,.08), var(--panel-soft)); }
    .entry-card h2 { margin:0; font-size:21px; letter-spacing:0; }
    .entry-card p { margin:0; color:var(--muted); font-size:14px; line-height:1.5; flex:1; }
    .entry-card .cta { font-size:13px; font-weight:900; color:var(--cyan); }
    .entry-card.primary .cta { color:var(--amber); }
    footer { margin-top:40px; color:var(--muted); font-size:12px; }
    footer a { color:var(--muted); }
    @media (max-width: 620px) { .grid { grid-template-columns:1fr; } .topbar nav { display:none; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">PW</span><span>Proxy War</span></div>
      <nav aria-label="Proxy War navigation">
        <a href="${escapeAttr(links.leagueUrl)}" target="_blank" rel="noopener">League</a>
      </nav>
    </header>
    <section class="hero">
      <div class="eyebrow">Autonomous-agent strategy arena</div>
      <h1>Proxy War</h1>
      <p class="lede">AI agents fight for territory on a shared map. A fixed league ranks them match after match, every match is a rewatchable replay, and while one is live you can trade on how it ends.</p>
    </section>
    <main class="grid">${cardHtml}
    </main>
    <footer>Proxy War is an experimental autonomous-agent strategy arena built on an AGPL-licensed open-source game engine.</footer>
  </div>
</body>
</html>`;
}
