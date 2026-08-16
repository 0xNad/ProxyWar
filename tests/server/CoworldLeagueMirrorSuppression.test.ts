import { describe, expect, test } from "vitest";
import {
  mergeEpisodeRows,
  selectPublishedEpisodeRows,
} from "../../src/server/agents/CoworldLeagueMirrorCore";
import {
  buildPremiereSiteBlock,
  classifyEpisodeSuppression,
  filterSuppressedEpisodeRows,
  parsePremiereSuppressionContract,
  PREMIERE_SUPPRESSION_SCHEMA_VERSION,
  PREMIERE_SUPPRESSION_STALE_MS,
  type PremiereSuppressionContract,
  type PremiereSuppressionHold,
  type PremiereSuppressionState,
} from "../../src/server/agents/CoworldLeaguePremiereSuppression";
import {
  coworldLeagueIndexHtml,
  type CoworldLeagueEpisodeRow,
  type CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";
// Reuse the premiere leak audit's OWN matchers as the test oracle so this test
// asserts with exactly the semantics that gate real premiere admission:
// case-insensitive substring for HTML, exact string-leaf for structured JSON.
import englishTranslations from "../../resources/lang/en.json";
import {
  containsExactStructuredIdentity,
  containsForbiddenText,
} from "../../src/server/replay-premiere/ReplayPremiereEligibility";

const NOW = new Date("2026-07-21T12:00:00.000Z");

// Unique fingerprints that appear NOWHERE else in the fixtures, so their
// presence/absence in the output is a clean leak signal.
const SECRET = {
  episodeRequestId: "ereq_zzsecretheld",
  shortId: "zzsecretheld",
  runId: "run_zzsecretheld",
  winner: "ZebulonSecret",
  loser: "QuillonSecret",
};
const SECRET_HTML_FINGERPRINTS = [
  SECRET.episodeRequestId,
  SECRET.runId,
  SECRET.shortId,
  SECRET.winner,
  SECRET.loser,
];
const SECRET_JSON_LEAVES = [
  SECRET.episodeRequestId,
  SECRET.shortId,
  SECRET.winner,
  SECRET.loser,
];

function episodeRow(
  overrides: Partial<CoworldLeagueEpisodeRow> = {},
): CoworldLeagueEpisodeRow {
  return {
    episodeRequestId: "ereq_normal0001",
    shortId: "normal0001",
    roundNumber: 512,
    completedAt: "2026-07-21T09:00:00.000Z",
    map: "Europe",
    mapSize: "Large",
    turnCount: 3000,
    decisionCount: 300,
    degradedCount: 0,
    winnerName: "Auri",
    players: [
      {
        slot: 0,
        name: "Auri",
        tilesOwned: 900,
        isAlive: true,
        isWinner: true,
        color: "#7ad7f0",
      },
      {
        slot: 1,
        name: "daveey",
        tilesOwned: 100,
        isAlive: false,
        isWinner: false,
        color: "#f4a64a",
      },
    ],
    watchHref: "/ai-league-runs/league-run_normal0001/spectator.html",
    fullRenderHref: "/ai-league-replay/league-run_normal0001",
    ...overrides,
  };
}

function secretHeldEpisode(): CoworldLeagueEpisodeRow {
  return episodeRow({
    episodeRequestId: SECRET.episodeRequestId,
    shortId: SECRET.shortId,
    completedAt: "2026-07-21T11:50:00.000Z",
    winnerName: SECRET.winner,
    players: [
      {
        slot: 0,
        name: SECRET.winner,
        tilesOwned: 800,
        isAlive: true,
        isWinner: true,
        color: "#7ee0a8",
      },
      {
        slot: 1,
        name: SECRET.loser,
        tilesOwned: 60,
        isAlive: false,
        isWinner: false,
        color: "#ff9b8f",
      },
    ],
    watchHref: `/ai-league-runs/league-${SECRET.runId}/spectator.html`,
    fullRenderHref: `/ai-league-replay/league-${SECRET.runId}`,
  });
}

function mirrorData(
  episodes: CoworldLeagueEpisodeRow[],
): CoworldLeagueMirrorData {
  return {
    generatedAt: NOW.toISOString(),
    lastGoodSyncAt: NOW.toISOString(),
    stale: false,
    championFeedStale: false,
    replayFeedStale: false,
    lastGoodReplaySyncAt: NOW.toISOString(),
    league: {
      id: "league_test",
      name: "Proxywar",
      description: "Test league",
      divisionName: "Competition",
      roundIntervalMinutes: 30,
      episodesPerRound: 8,
      currentRoundNumber: 512,
      currentRoundStatus: "running",
      scoreLabel: "Score",
    },
    standings: [
      {
        rank: 1,
        playerName: "odin",
        ratingPolicyLabel: "odin:v2",
        activeChampionPolicyLabel: "odin:v2",
        policyLabel: "odin:v2",
        score: 30.65,
        roundsPlayed: 27,
        isHouse: false,
      },
    ],
    rounds: [
      {
        roundNumber: 512,
        status: "running",
        startedAt: NOW.toISOString(),
        completedAt: null,
      },
      {
        roundNumber: 511,
        status: "completed",
        startedAt: "2026-07-21T11:30:00.000Z",
        completedAt: "2026-07-21T11:45:00.000Z",
      },
    ],
    episodes,
    links: {
      enterTheLeagueUrl: "https://github.com/0xNad/proxywar-coworld-starter",
      platformLabel: "Softmax Coworld",
    },
  };
}

function hold(
  overrides: Partial<PremiereSuppressionHold> = {},
): PremiereSuppressionHold {
  return {
    episodeRequestId: SECRET.episodeRequestId,
    premiereId: "prem_live_test",
    roundId: "round_512",
    roundNumber: 512,
    scheduledAt: "2026-07-21T12:05:00.000Z",
    holdExpiresAt: "2026-07-21T12:45:00.000Z",
    premierePageLive: true,
    mapLabel: "Europe",
    ...overrides,
  };
}

function activeContract(
  overrides: Partial<PremiereSuppressionContract> = {},
  now: Date = NOW,
): PremiereSuppressionState {
  const raw = JSON.stringify({
    schemaVersion: PREMIERE_SUPPRESSION_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    quarantineMs: 12 * 60 * 1000,
    holds: [hold()],
    ...overrides,
  });
  const state = parsePremiereSuppressionContract(raw, now);
  if (state.status !== "active") {
    throw new Error(`expected active contract, got ${state.reason}`);
  }
  return state;
}

// The exact final assembly the mirror performs after building the merged
// episode list: final-defense filter + optional premiere block.
function assemble(
  baseline: CoworldLeagueMirrorData,
  state: PremiereSuppressionState,
  now: Date,
): CoworldLeagueMirrorData {
  const publishedEpisodes = filterSuppressedEpisodeRows(
    state,
    baseline.episodes,
    now,
  );
  const premiere = buildPremiereSiteBlock(state, now);
  return {
    ...baseline,
    episodes: publishedEpisodes,
    ...(premiere !== null ? { premiere } : {}),
  };
}

function render(data: CoworldLeagueMirrorData): {
  html: string;
  json: unknown;
} {
  return {
    html: coworldLeagueIndexHtml(data),
    json: JSON.parse(`${JSON.stringify(data, null, 2)}\n`),
  };
}

describe("mirror suppression — held episode never reaches the league page", () => {
  test("(a) a held episode leaks into NO data.json leaf and NO index.html substring", () => {
    const baseline = mirrorData([secretHeldEpisode(), episodeRow()]);

    // Positive control: without an active contract the secret episode DOES
    // appear — proving the fingerprints and the leak oracle actually fire.
    const published = render(baseline);
    expect(
      containsForbiddenText(published.html, SECRET_HTML_FINGERPRINTS),
    ).toBe(true);
    expect(
      containsExactStructuredIdentity(published.json, SECRET_JSON_LEAVES),
    ).toBe(true);

    // With an active hold (and its premiere card rendered), nothing leaks.
    const suppressed = render(assemble(baseline, activeContract(), NOW));
    expect(
      containsForbiddenText(suppressed.html, SECRET_HTML_FINGERPRINTS),
    ).toBe(false);
    expect(
      containsExactStructuredIdentity(suppressed.json, SECRET_JSON_LEAVES),
    ).toBe(false);
  });

  test("(d) the merged-list final filter drops a previously-published held card", () => {
    // mergeEpisodeRows retains a card published in an earlier cycle.
    const merged = mergeEpisodeRows(
      [episodeRow({ episodeRequestId: "ereq_fresh", shortId: "fresh" })],
      [secretHeldEpisode(), episodeRow()],
      12,
    );
    expect(merged.map((row) => row.episodeRequestId)).toContain(
      SECRET.episodeRequestId,
    );

    // Positive control: the merged list, unfiltered, would leak.
    const leaked = render(mirrorData(merged));
    expect(containsForbiddenText(leaked.html, SECRET_HTML_FINGERPRINTS)).toBe(
      true,
    );

    // Final defense removes the held card before it reaches data.json.
    const suppressed = render(
      assemble(mirrorData(merged), activeContract(), NOW),
    );
    const publishedIds = (
      suppressed.json as { episodes: CoworldLeagueEpisodeRow[] }
    ).episodes.map((row) => row.episodeRequestId);
    expect(publishedIds).not.toContain(SECRET.episodeRequestId);
    expect(
      containsForbiddenText(suppressed.html, SECRET_HTML_FINGERPRINTS),
    ).toBe(false);
    expect(
      containsExactStructuredIdentity(suppressed.json, SECRET_JSON_LEAVES),
    ).toBe(false);
  });
});

describe("mirror suppression — quarantine defers then publishes", () => {
  const FRESH = "FreshCombatantXyz";
  function freshEpisode(): CoworldLeagueEpisodeRow {
    return episodeRow({
      episodeRequestId: "ereq_freshq",
      shortId: "freshq",
      completedAt: "2026-07-21T11:59:00.000Z", // 1 minute before NOW
      winnerName: FRESH,
      players: [
        {
          slot: 0,
          name: FRESH,
          tilesOwned: 500,
          isAlive: true,
          isWinner: true,
          color: "#7ad7f0",
        },
      ],
      watchHref: "/ai-league-runs/league-run_freshq/spectator.html",
      fullRenderHref: "/ai-league-replay/league-run_freshq",
    });
  }

  test("(b) a freshly-completed episode is deferred inside the window, then published after it", () => {
    const baseline = mirrorData([freshEpisode()]);
    // No holds; blanket 12-minute quarantine.
    const state = activeContract({ holds: [] });

    // Inside the window (episode completed 1 min ago): deferred.
    const inside = render(assemble(baseline, state, NOW));
    expect(containsForbiddenText(inside.html, [FRESH])).toBe(false);

    // 11 minutes later the same contract is still fresh, but the episode has
    // aged out of the quarantine window and publishes.
    const later = new Date(NOW.getTime() + 11 * 60 * 1000);
    const laterState = activeContract(
      {
        generatedAt: new Date(later.getTime() - 60 * 1000).toISOString(),
        holds: [],
      },
      later,
    );
    const outside = render(assemble(baseline, laterState, later));
    expect(containsForbiddenText(outside.html, [FRESH])).toBe(true);
  });
});

describe("mirror suppression — inert when the contract is stale or absent", () => {
  const staleStates: Array<[string, PremiereSuppressionState]> = [
    [
      "absent contract (not_configured)",
      { status: "stale", reason: "not_configured" },
    ],
    [
      "stale generatedAt",
      parsePremiereSuppressionContract(
        JSON.stringify({
          schemaVersion: PREMIERE_SUPPRESSION_SCHEMA_VERSION,
          generatedAt: new Date(
            NOW.getTime() - PREMIERE_SUPPRESSION_STALE_MS,
          ).toISOString(),
          quarantineMs: 12 * 60 * 1000,
          holds: [hold()],
        }),
        NOW,
      ),
    ],
  ];

  test.each(staleStates)(
    "(c) %s reproduces today's output byte-identically",
    (_label, state) => {
      // Baseline includes what WOULD be a held episode, to prove a stale state
      // suppresses nothing.
      const baseline = mirrorData([secretHeldEpisode(), episodeRow()]);
      const assembled = assemble(baseline, state, NOW);

      // Upstream meta/per-episode gates are no-ops for a stale state too.
      expect(
        classifyEpisodeSuppression(
          state,
          {
            episodeRequestId: SECRET.episodeRequestId,
            completedAt: "2026-07-21T11:59:00.000Z",
          },
          NOW,
        ),
      ).toBe("publish");

      expect(assembled).toEqual(baseline);
      expect(assembled).not.toHaveProperty("premiere");
      expect(JSON.stringify(assembled, null, 2)).toBe(
        JSON.stringify(baseline, null, 2),
      );
      expect(coworldLeagueIndexHtml(assembled)).toBe(
        coworldLeagueIndexHtml(baseline),
      );

      // Regression guard against the PRE-premiere layout (not just post-change
      // self-consistency): with no premiere the metric grid must close directly
      // onto the standings section with no injected card or blank line, and no
      // round pill may gain the "premiering" accent. These literal bytes match
      // the mirror's output at the release SHA.
      const html = coworldLeagueIndexHtml(assembled);
      expect(html).toContain(
        '</div>\n    <section>\n      <h2 id="standings-title">Standings',
      );
      expect(html).not.toContain("premiere-section");
      // No LIVE-badge markup or its scoped CSS leaks into the inert path.
      expect(html).not.toContain("premiere-badge");
      expect(html).not.toContain("premiering");
    },
  );
});

describe("premiere card render + en.json keys", () => {
  const premiereKeys = [
    "premiere_now_eyebrow",
    "premiere_scheduled_eyebrow",
    "premiere_heading",
    "premiere_now_body",
    "premiere_scheduled_body",
    "premiere_watch",
    "premiere_live",
    "premiere_label",
    "premiere_starts",
  ];

  test("all premiere card en.json keys are present", () => {
    for (const key of premiereKeys) {
      expect(englishTranslations.coworld_league).toHaveProperty(key);
      expect(
        (englishTranslations.coworld_league as Record<string, string>)[key]
          .length,
      ).toBeGreaterThan(0);
    }
  });

  test("a live premiere renders the loud LIVE badge, the /premiere link, and the round-pill accent without leaking a held match", () => {
    // A held secret episode sits in the baseline, so this doubles as a
    // spoiler-clean proof: the loud LIVE badge must add no forbidden fingerprint.
    const data = assemble(
      mirrorData([secretHeldEpisode(), episodeRow()]),
      activeContract(),
      NOW,
    );
    const html = coworldLeagueIndexHtml(data);
    expect(html).toContain("premiere-card");
    // The loudest element: a red LIVE pill (dot + the LIVE word). Assert the
    // rendered element, not the scoped CSS selector text of the same name.
    expect(html).toContain(
      `<div class="premiere-badge live"><span class="premiere-badge-dot" aria-hidden="true"></span>${englishTranslations.coworld_league.premiere_live}</div>`,
    );
    expect(html).toContain(
      englishTranslations.coworld_league.premiere_now_eyebrow,
    );
    expect(html).toContain(englishTranslations.coworld_league.premiere_heading);
    // Clear watch CTA to the live premiere page.
    expect(html).toContain('href="/premiere/prem_live_test"');
    expect(html).toContain(englishTranslations.coworld_league.premiere_watch);
    // Round 512 pill gains the "premiering" accent.
    expect(html).toMatch(/round-pill[^"]*premiering">#512\b/);
    // The leak audit's own oracle: the loud badge introduced no held-match leak.
    expect(containsForbiddenText(html, SECRET_HTML_FINGERPRINTS)).toBe(false);
    expect(
      containsExactStructuredIdentity(
        JSON.parse(`${JSON.stringify(data, null, 2)}\n`),
        SECRET_JSON_LEAVES,
      ),
    ).toBe(false);
  });

  test("a scheduled (not-live) premiere renders a calmer Premiere label and start time with no LIVE badge or /premiere link", () => {
    const state = activeContract({
      holds: [hold({ premierePageLive: false })],
    });
    const data = assemble(mirrorData([episodeRow()]), state, NOW);
    const html = coworldLeagueIndexHtml(data);
    expect(html).toContain(
      englishTranslations.coworld_league.premiere_scheduled_eyebrow,
    );
    // Calmer badge: a "Premiere" label plus the localized start time. The time
    // sits in its own [data-utc] span so the client localizer rewrites just the
    // time while the "Starts" prefix survives.
    const startsPrefix =
      englishTranslations.coworld_league.premiere_starts.replace("{time}", "");
    expect(html).toContain(
      `<div class="premiere-badge scheduled"><span>${englishTranslations.coworld_league.premiere_label}</span>`,
    );
    expect(html).toContain(
      `<span class="premiere-starts">${startsPrefix}<span data-utc="2026-07-21T12:05:00.000Z">`,
    );
    // Not yet live: no loud red badge element, no red dot element, no watch link.
    // (The scoped CSS names still appear in <style>; assert on rendered markup.)
    expect(html).not.toContain('class="premiere-badge live"');
    expect(html).not.toContain('<span class="premiere-badge-dot"');
    expect(html).not.toContain('href="/premiere/');
  });
});

describe("revealed-premiere links never bypass suppression", () => {
  test("a held or quarantined row is dropped WHOLE — an attached premiereHref never reaches HTML or data.json", () => {
    // Defensive impossibility drill: by construction the mirror only attaches
    // premiereHref for REVEALED premieres (archive-index pointers exist only
    // post-terminal reclamation), so a held/quarantined episode can never
    // legitimately carry one. Even if a row somehow did, suppression drops the
    // entire row — the link goes with it.
    const heldWithLink = {
      ...secretHeldEpisode(),
      premiereHref: "/premiere/prem_live_test",
    };
    const quarantinedWithLink = {
      ...episodeRow({
        episodeRequestId: "ereq_freshlinked",
        shortId: "freshlinked",
        completedAt: "2026-07-21T11:59:30.000Z", // 30s before NOW
      }),
      premiereHref: "/premiere/prem_quarantinedfresh1",
    };
    const oldRevealed = {
      ...episodeRow(),
      premiereHref: "/premiere/prem_oldrevealedok0001",
    };
    const data = assemble(
      mirrorData([heldWithLink, quarantinedWithLink, oldRevealed]),
      activeContract(),
      NOW,
    );
    const html = coworldLeagueIndexHtml(data);
    const json = JSON.parse(`${JSON.stringify(data, null, 2)}\n`) as {
      episodes: CoworldLeagueEpisodeRow[];
    };
    // The held card (and its link) is gone; the fresh card (and its link) is
    // deferred; the old revealed card keeps its premiere link.
    expect(html).not.toContain("prem_quarantinedfresh1");
    expect(json.episodes.map((row) => row.episodeRequestId)).toEqual([
      episodeRow().episodeRequestId,
    ]);
    expect(html).toContain(
      '<a href="/premiere/prem_oldrevealedok0001">▶ Watch the premiere</a>',
    );
    // The held premiere id appears ONLY as the live premiere card's own
    // /premiere link (contract-derived), never via the suppressed battle row.
    expect(containsForbiddenText(html, SECRET_HTML_FINGERPRINTS)).toBe(false);
    expect(containsExactStructuredIdentity(json, SECRET_JSON_LEAVES)).toBe(
      false,
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// 2026-08-16 archive-wipe regression: an all-quarantined cycle must never
// publish an empty list over a populated archive. selectPublishedEpisodeRows
// is the single decision point the mirror now uses for retention + shield.
// ————————————————————————————————————————————————————————————————————————

function agedRow(id: string, hoursAgo: number): CoworldLeagueEpisodeRow {
  return episodeRow({
    episodeRequestId: `ereq_${id}`,
    shortId: id,
    completedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  });
}

describe("mirror retention — the all-quarantined cycle (2026-08-16 wipe)", () => {
  test("every fresh candidate deferred → previously published cards are retained", () => {
    const state = activeContract({ holds: [] }); // blanket 12-min quarantine
    const previous = [
      agedRow("olda", 2),
      agedRow("oldb", 3),
      agedRow("oldc", 4),
    ];
    const selection = selectPublishedEpisodeRows({
      freshEpisodes: [],
      previousEpisodes: previous,
      maxRenderedEpisodes: 12,
      replayFeedStale: false,
      suppressionDeferredCount: 12,
      finalSuppression: state,
      now: NOW,
    });
    expect(selection.published.map((row) => row.episodeRequestId)).toEqual([
      "ereq_olda",
      "ereq_oldb",
      "ereq_oldc",
    ]);
    expect(selection.retainedPreviousOverEmpty).toBe(false);
    expect(selection.suppressedFromMerged).toBe(0);
  });

  test("partial deferral merges fresh revealable rows with retained cards, newest first", () => {
    const state = activeContract({ holds: [] });
    const fresh = [agedRow("fresh1", 1)];
    const previous = [agedRow("olda", 2), agedRow("oldb", 3)];
    const selection = selectPublishedEpisodeRows({
      freshEpisodes: fresh,
      previousEpisodes: previous,
      maxRenderedEpisodes: 12,
      replayFeedStale: false,
      suppressionDeferredCount: 5,
      finalSuppression: state,
      now: NOW,
    });
    expect(selection.published.map((row) => row.episodeRequestId)).toEqual([
      "ereq_fresh1",
      "ereq_olda",
      "ereq_oldb",
    ]);
  });

  test("a previously published card that is NOW quarantined is still stripped (shield intact)", () => {
    const state = activeContract({ holds: [] });
    const requarantined = episodeRow({
      episodeRequestId: "ereq_requar",
      shortId: "requar",
      completedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    const selection = selectPublishedEpisodeRows({
      freshEpisodes: [],
      previousEpisodes: [requarantined, agedRow("olda", 2)],
      maxRenderedEpisodes: 12,
      replayFeedStale: false,
      suppressionDeferredCount: 3,
      finalSuppression: state,
      now: NOW,
    });
    expect(selection.published.map((row) => row.episodeRequestId)).toEqual([
      "ereq_olda",
    ]);
    expect(selection.suppressedFromMerged).toBe(1);
  });

  test("healthy cycle with zero deferrals publishes exactly the fresh list (no behavior change)", () => {
    const state = activeContract({ holds: [] });
    const fresh = [agedRow("fresh1", 1), agedRow("fresh2", 2)];
    const selection = selectPublishedEpisodeRows({
      freshEpisodes: fresh,
      previousEpisodes: [agedRow("rotated", 9)],
      maxRenderedEpisodes: 12,
      replayFeedStale: false,
      suppressionDeferredCount: 0,
      finalSuppression: state,
      now: NOW,
    });
    expect(selection.published.map((row) => row.episodeRequestId)).toEqual([
      "ereq_fresh1",
      "ereq_fresh2",
    ]);
    expect(selection.retainedPreviousOverEmpty).toBe(false);
  });

  test("last resort: a fresh list that filters to empty never overwrites a populated archive", () => {
    const state = activeContract({ holds: [] });
    const midCycleQuarantined = episodeRow({
      episodeRequestId: "ereq_race",
      shortId: "race",
      completedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(),
    });
    const selection = selectPublishedEpisodeRows({
      freshEpisodes: [midCycleQuarantined],
      previousEpisodes: [agedRow("olda", 2)],
      maxRenderedEpisodes: 12,
      replayFeedStale: false,
      suppressionDeferredCount: 0,
      finalSuppression: state,
      now: NOW,
    });
    expect(selection.published.map((row) => row.episodeRequestId)).toEqual([
      "ereq_olda",
    ]);
    expect(selection.retainedPreviousOverEmpty).toBe(true);
  });
});
