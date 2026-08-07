import { UserSettings } from "../core/game/UserSettings";

export function isAiLeagueReplayRoute(
  pathname = window.location.pathname,
): boolean {
  return (
    (typeof window !== "undefined" &&
      window.__PROXYWAR_STATIC_REPLAY__ === true) ||
    isReplayPremiereRoute(pathname) ||
    isBettingPremiereRoute(pathname) ||
    pathname.startsWith("/ai-league-replay/") ||
    pathname.startsWith("/proxywar-replay/") ||
    // Legacy path — previously published replay links must keep working.
    pathname.startsWith("/openfront-replay/") ||
    isCoworldReplayRoute(pathname) ||
    isCoworldPlayerRoute(pathname)
  );
}

/**
 * A Premiere uses the real replay renderer, but its progressive transport is
 * intentionally separate from the ordinary artifact-backed replay routes.
 */
export function isReplayPremiereRoute(
  pathname = window.location.pathname,
): boolean {
  return /^\/premiere\/prem_[a-z0-9]{16,32}$/.test(pathname);
}

/**
 * The dedicated betting page (`/bet/<id>`) mounts the same
 * `ReplayPremiereRuntimeController` progressive-replay transport as
 * `/premiere/<id>` (see `BettingPremierePage.ts`) — it must be classified
 * identically for every consumer of `isAiLeagueReplayRoute`, including the
 * landing page's ambient `PublicLobbySocket` (`LobbySocket.ts`), which
 * otherwise opens a `/w1/lobbies` websocket on every route regardless of
 * whether the route actually needs the ordinary multiplayer lobby list.
 * LEAGUE builds keep this exact classification too (this module is never
 * stubbed), but the page behind it is — `/bet/<id>` there warns once and
 * redirects to /league (see prediction/leagueStubs/BettingPremierePage.ts).
 */
export function isBettingPremiereRoute(
  pathname = window.location.pathname,
): boolean {
  return /^\/bet\/prem_[a-z0-9]{16,32}$/.test(pathname);
}

export function isCoworldReplayRoute(
  pathname = window.location.pathname,
): boolean {
  return (
    isCoworldRoute(pathname, "/client/global") ||
    isCoworldRoute(pathname, "/client/replay")
  );
}

export function isCoworldPlayerRoute(
  pathname = window.location.pathname,
): boolean {
  return isCoworldRoute(pathname, "/client/player");
}

function isCoworldRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.endsWith(`/proxy${route}`);
}

const spectatorNameByAgentName = new Map<string, string>([
  ["Aggressive Agent 1", "Iron Atlas"],
  ["Defensive Agent 2", "Bastion"],
  ["Diplomatic Agent 3", "Silver Accord"],
  ["Opportunistic Agent 4", "Vantage"],
  ["Aggressive Agent 5", "Redline"],
]);

/**
 * P0 fix (2026-08-03, deploy 2B): the "Anonymous Names" user setting
 * (UserSettings.anonymousNames(), Settings modal) already hides player
 * identities on the ordinary multiplayer lobby/game surfaces
 * (LobbyPlayerView.ts) but was never wired into the AI League replay
 * surface at all -- a viewer with the setting ON still saw
 * every real agent name streaming through the War Room feed, the
 * headline lower-third toasts, the social/diplomacy transcript, and the
 * decision log, because every one of those already funnels its display
 * name through `aiLeagueSpectatorDisplayName`/`aiLeagueSpectatorText`
 * below for the UNRELATED native-spectator-ui promo rebrand -- this is
 * the ONE choke point nearly every caller in AiLeagueReplayOverlay.ts
 * already goes through, so anonymizing here fixes all of them at once.
 * Deterministic per real name within one page load (same agent always
 * maps to the same "Agent N" label for the whole viewing session,
 * assigned in first-seen order) -- never a per-call random pick, which
 * would make a single event's own actor/target text visibly disagree
 * with itself.
 */
const anonymizedAgentNameByRealName = new Map<string, string>();
let nextAnonymizedAgentNumber = 1;

function anonymizeAgentName(realName: string): string {
  let anonymized = anonymizedAgentNameByRealName.get(realName);
  if (anonymized === undefined) {
    anonymized = `Agent ${nextAnonymizedAgentNumber}`;
    nextAnonymizedAgentNumber += 1;
    anonymizedAgentNameByRealName.set(realName, anonymized);
  }
  return anonymized;
}

export function aiLeagueSpectatorDisplayName(displayName: string): string {
  const rebranded = spectatorNameByAgentName.get(displayName) ?? displayName;
  if (new UserSettings().anonymousNames()) {
    return anonymizeAgentName(rebranded);
  }
  return rebranded;
}

export function aiLeagueSpectatorText(text: string): string {
  let result = text;
  for (const [agentName, spectatorName] of spectatorNameByAgentName) {
    result = result.split(agentName).join(spectatorName);
  }
  if (new UserSettings().anonymousNames()) {
    for (const [realName, anonymized] of anonymizedAgentNameByRealName) {
      result = result.split(realName).join(anonymized);
    }
  }
  return result;
}

export function isAiLeagueNativeSpectatorUiEnabled(): boolean {
  if (!isAiLeagueReplayRoute()) {
    return false;
  }

  const runtimeWindow = window as typeof window & {
    __openFrontPromoNativeUi?: boolean;
  };
  if (runtimeWindow.__openFrontPromoNativeUi === true) {
    return true;
  }

  const params = new URLSearchParams(window.location.search);
  return params.has("native-spectator-ui");
}
