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

export function aiLeagueSpectatorDisplayName(displayName: string): string {
  return spectatorNameByAgentName.get(displayName) ?? displayName;
}

export function aiLeagueSpectatorText(text: string): string {
  let result = text;
  for (const [agentName, spectatorName] of spectatorNameByAgentName) {
    result = result.split(agentName).join(spectatorName);
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
