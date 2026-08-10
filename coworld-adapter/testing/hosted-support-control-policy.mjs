/**
 * Deterministic eval-only counterparty for hosted support-deal acceptance.
 *
 * It establishes a core alliance using an offered LegalAction.id, keeps
 * ordinary expansion moving, and asks each currently friendly player for
 * support whenever the server exposes that exact structured-deal action.
 * Rejections are intentionally eligible for a later server-governed retry so
 * an LLM starter gets a real post-plan opportunity instead of only the first
 * startup decision. This policy is an evaluation fixture and must never be
 * submitted to the league.
 */

const DEAL_KINDS = new Set([
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
]);

const ACCEPTED_INCOMING_TEMPLATES = new Set([
  "non_aggression_pact",
  "trade_security_pact",
]);

export function createHostedSupportControlPolicy() {
  let lastSupportRecipientID = null;
  return function chooseHostedSupportControlDecision(input = {}) {
    const actions = stableActions(input.legalActions);
    const observation = input.observation ?? {};
    const primary = choosePrimary(actions, observation);
    const deal = chooseDeal(actions, observation, lastSupportRecipientID);
    if (deal?.kind === "deal_propose") {
      lastSupportRecipientID = recipientID(deal);
    }
    return {
      selectedLegalActionId: primary.id,
      ...(deal ? { selectedDealActionId: deal.id } : {}),
      reason: deal
        ? `Hosted support control uses ${primary.kind} and ${deal.kind}.`
        : `Hosted support control uses ${primary.kind}; no eligible deal action.`,
      confidence: 1,
      fallbackUsed: false,
      llmPlannerDegraded: false,
    };
  };
}

export const chooseHostedSupportControlDecision =
  createHostedSupportControlPolicy();

function stableActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("decision_request contained no legalActions");
  }
  return [...actions]
    .filter(
      (action) =>
        action &&
        typeof action.id === "string" &&
        typeof action.kind === "string",
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function choosePrimary(actions, observation) {
  const gameActions = actions.filter((action) => !DEAL_KINDS.has(action.kind));
  if (gameActions.length === 0) {
    throw new Error("decision_request contained no primary game action");
  }

  const nonFriendly = [...(observation.visiblePlayers ?? [])]
    .filter(
      (player) =>
        player?.playerID &&
        player.isAlive !== false &&
        player.isFriendly !== true,
    )
    .sort((a, b) => String(a.playerID).localeCompare(String(b.playerID)));
  for (const player of nonFriendly) {
    const alliance = gameActions.find(
      (action) =>
        action.kind === "alliance_request" &&
        recipientID(action) === player.playerID,
    );
    if (alliance) return alliance;
  }

  const priorities = [
    (action) => action.kind === "spawn",
    (action) => action.kind === "attack" && action.metadata?.expansion === true,
    (action) => action.kind === "build",
    (action) => action.kind === "upgrade_structure",
    (action) => action.kind === "boat" && !action.metadata?.targetID,
    (action) => action.kind === "hold",
    (action) => action.kind === "attack",
    (action) => action.kind === "boat",
  ];
  for (const matches of priorities) {
    const selected = gameActions.find(
      (action) => matches(action) && action.risk?.level !== "high",
    );
    if (selected) return selected;
  }
  return gameActions[0];
}

function chooseDeal(actions, observation, lastSupportRecipientID) {
  const incoming = [...(observation.deals?.incomingProposals ?? [])].sort(
    (a, b) => String(a.dealID).localeCompare(String(b.dealID)),
  );
  for (const proposal of incoming) {
    const kind = ACCEPTED_INCOMING_TEMPLATES.has(proposal?.terms?.template)
      ? "deal_accept"
      : "deal_reject";
    const response = actions.find(
      (action) =>
        action.kind === kind && action.metadata?.dealID === proposal.dealID,
    );
    if (response) return response;
  }

  const friendlyIDs = new Set(
    (observation.visiblePlayers ?? [])
      .filter(
        (player) =>
          player?.playerID &&
          player.isAlive !== false &&
          player.isFriendly === true,
      )
      .map((player) => player.playerID),
  );
  const candidates = actions.filter(
    (action) =>
      action.kind === "deal_propose" &&
      action.metadata?.template === "support_request" &&
      friendlyIDs.has(recipientID(action)),
  );
  if (candidates.length === 0) return null;
  const previousIndex = candidates.findIndex(
    (action) => recipientID(action) === lastSupportRecipientID,
  );
  return candidates[(previousIndex + 1) % candidates.length];
}

function recipientID(action) {
  return action.metadata?.recipientID ?? action.metadata?.targetID ?? null;
}
