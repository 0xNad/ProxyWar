import {
  WORLD_THEATRE_IDS,
  type WorldModel,
  type WorldTheatre,
  type WorldTheatreId,
} from "../../../src/client/publicapp/WorldModelSchema";

/** A small but complete `world.json` for client tests. */

const BATTLEFIELDS: Record<WorldTheatreId, string[]> = {
  north_america: ["northamerica"],
  south_america: ["southamerica", "amazonriver"],
  britannia: ["britannia", "britanniaclassic"],
  europe: ["europe", "europeclassic"],
  black_sea: ["blacksea"],
  middle_east: ["mena", "middleeast"],
  africa: ["africa"],
  asia: ["asia"],
  east_asia: ["eastasia", "japan"],
  oceania: ["oceania", "australia"],
  crown: ["pangaea", "world", "giantworldmap"],
};

function unclaimed(id: WorldTheatreId): WorldTheatre {
  return {
    id,
    battlefields: BATTLEFIELDS[id],
    status: "unclaimed",
    holder: null,
    heldSince: null,
    holderWins: 0,
    challenger: null,
    challengerWins: 0,
    battleCount: 0,
    lastBattleAt: null,
    window: [],
    tallies: [],
    maps: [],
    reigns: [],
  };
}

function battle(id: string, map: string, winner: string | null, at: string) {
  return { episodeRequestId: id, map, winner, at, href: `/match/${id}` };
}

export function worldFixture(overrides: Partial<WorldModel> = {}): WorldModel {
  const theatres = WORLD_THEATRE_IDS.map((id) => unclaimed(id));
  const set = (theatre: WorldTheatre) => {
    theatres[theatres.findIndex((entry) => entry.id === theatre.id)] = theatre;
  };
  set({
    ...unclaimed("asia"),
    status: "contested",
    holder: "Matt Van",
    heldSince: "2026-09-28T20:26:46.233Z",
    holderWins: 2,
    challenger: "relh",
    challengerWins: 2,
    battleCount: 795,
    lastBattleAt: "2026-09-29T21:12:19.144Z",
    window: [
      battle("ereq_asia1", "Asia", "Matt Van", "2026-09-29T19:00:00.000Z"),
      battle("ereq_asia2", "Asia", "relh", "2026-09-29T20:00:00.000Z"),
      battle("ereq_asia3", "Asia", null, "2026-09-29T20:30:00.000Z"),
      battle("ereq_asia4", "Asia", "Matt Van", "2026-09-29T21:00:00.000Z"),
      battle("ereq_asia5", "Asia", "relh", "2026-09-29T21:12:19.144Z"),
    ],
    tallies: [
      { name: "Matt Van", wins: 2 },
      { name: "relh", wins: 2 },
    ],
    maps: [{ map: "Asia", battles: 795 }],
    reigns: [
      {
        holder: "Matt Van",
        from: "2026-09-28T20:26:46.233Z",
        to: null,
        battles: 9,
        wins: 3,
      },
      {
        holder: "Alpha",
        from: "2026-09-25T10:00:00.000Z",
        to: "2026-09-28T20:26:46.233Z",
        battles: 30,
        wins: 8,
      },
    ],
  });
  set({
    ...unclaimed("oceania"),
    status: "held",
    holder: "Alpha",
    heldSince: "2026-09-29T08:23:03.270Z",
    holderWins: 3,
    challenger: "Matt Van",
    challengerWins: 1,
    battleCount: 959,
    lastBattleAt: "2026-09-29T21:47:01.932Z",
    window: [
      battle("ereq_oc1", "Oceania", "Alpha", "2026-09-29T21:00:00.000Z"),
      battle("ereq_oc2", "Oceania", "Matt Van", "2026-09-29T21:20:00.000Z"),
    ],
    tallies: [
      { name: "Alpha", wins: 3 },
      { name: "Matt Van", wins: 1 },
    ],
    maps: [{ map: "Oceania", battles: 959 }],
    reigns: [
      {
        holder: "Alpha",
        from: "2026-09-29T08:23:03.270Z",
        to: null,
        battles: 4,
        wins: 3,
      },
    ],
  });
  set({
    ...unclaimed("crown"),
    status: "held",
    holder: "relh",
    heldSince: "2026-09-28T17:35:00.966Z",
    holderWins: 4,
    challenger: null,
    challengerWins: 0,
    battleCount: 10712,
    lastBattleAt: "2026-09-29T21:13:35.351Z",
    window: [battle("ereq_cr1", "Pangaea", "relh", "2026-09-29T21:13:35.351Z")],
    tallies: [{ name: "relh", wins: 4 }],
    maps: [
      { map: "Pangaea", battles: 9396 },
      { map: "World", battles: 1316 },
    ],
    reigns: [],
  });
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-29T22:05:00.000Z",
    windowSize: 12,
    battleCount: 14487,
    battlesLast24h: 41,
    firstBattleAt: "2026-07-17T04:40:12.902Z",
    lastBattleAt: "2026-09-29T21:47:01.932Z",
    feed: {
      stale: false,
      lastGoodSyncAt: "2026-09-29T22:05:00.000Z",
      currentRoundNumber: 2353,
      roundIntervalMinutes: 40,
    },
    theatres,
    events: [
      {
        kind: "siege",
        theatreId: "asia",
        at: "2026-09-29T21:12:19.144Z",
        episodeRequestId: "ereq_asia5",
        map: "Asia",
        agent: "relh",
        rival: "Matt Van",
        agentWins: 2,
        rivalWins: 2,
        href: "/match/ereq_asia5",
      },
      {
        kind: "conquest",
        theatreId: "crown",
        at: "2026-09-28T17:35:00.966Z",
        episodeRequestId: "ereq_cr0",
        map: "Pangaea",
        agent: "relh",
        rival: "Andre von Houck",
        agentWins: 4,
        rivalWins: 3,
        href: "/match/ereq_cr0",
      },
    ],
    timeline: [
      {
        day: "2026-09-27",
        holders: { asia: "Alpha", oceania: "Alpha", crown: "Andre von Houck" },
      },
      {
        day: "2026-09-28",
        holders: { asia: "Matt Van", oceania: "Alpha", crown: "relh" },
      },
      {
        day: "2026-09-29",
        holders: { asia: "Matt Van", oceania: "Alpha", crown: "relh" },
      },
    ],
    agents: [
      {
        name: "Matt Van",
        label: "Matt Van",
        slug: "matt-van",
        color: "#bc2fc6",
        secondaryColor: "#1e293b",
        emblemSvg:
          '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
        isHouse: false,
        theatres: ["asia"],
        conquests: 250,
        battlesWon: 1564,
      },
      {
        name: "Alpha",
        label: "Alpha",
        slug: "alpha",
        color: "#c62fc4",
        secondaryColor: "#1e293b",
        emblemSvg: null,
        isHouse: false,
        theatres: ["oceania"],
        conquests: 12,
        battlesWon: 90,
      },
      {
        name: "relh",
        label: "relh",
        slug: null,
        color: "#c66b2f",
        secondaryColor: "#1e293b",
        emblemSvg: null,
        isHouse: false,
        theatres: ["crown"],
        conquests: 164,
        battlesWon: 1282,
      },
      {
        name: "Andre von Houck",
        label: "Andre von Houck",
        slug: "andre-von-houck",
        color: "#2f78c6",
        secondaryColor: "#1e293b",
        emblemSvg: null,
        isHouse: false,
        theatres: [],
        conquests: 156,
        battlesWon: 1079,
      },
    ],
    links: {
      accountUrl: "https://proxywar.xyz/account",
      enterTheLeagueUrl: "https://github.com/0xNad/proxywar-coworld-starter",
    },
    ...overrides,
  };
}
