export function isAiLeagueReplayRoute(
  pathname = window.location.pathname,
): boolean {
  return (
    pathname.startsWith("/ai-league-replay/") ||
    pathname.startsWith("/openfront-replay/") ||
    isCoworldReplayRoute(pathname)
  );
}

export function isCoworldReplayRoute(
  pathname = window.location.pathname,
): boolean {
  return pathname === "/client/global" || pathname === "/client/replay";
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
