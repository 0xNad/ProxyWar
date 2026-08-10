/**
 * Deterministic eval-only counterparties for hosted social-deal validity.
 *
 * These profiles never invent intents. They select one offered primary
 * LegalAction.id and, when appropriate, one offered deal action in the
 * optional diplomacy slot. They are test instruments and must never be
 * submitted to the league.
 */

export const HOSTED_SOCIAL_COUNTERPARTY_PROFILES = [
  "pact-keeper",
  "pact-breaker",
  "mutual-aid",
  "deal-blind",
];

const DEAL_KINDS = new Set([
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
]);
const NEGATIVE_TEMPLATES = new Set([
  "non_aggression_pact",
  "trade_security_pact",
]);
const PACT_RETRY_STEPS = 30;
const SUPPORT_RETRY_STEPS = 60;
const MAX_ATTEMPTS_PER_KEY = 2;

export function resolveHostedSocialCounterpartyConfig(input = {}) {
  const profile =
    input.builtConfig?.profile ??
    input.argv?.[0] ??
    input.env?.PROXYWAR_HOSTED_SOCIAL_COUNTERPARTY;
  if (!HOSTED_SOCIAL_COUNTERPARTY_PROFILES.includes(profile)) {
    throw new Error(
      `profile must be one of ${HOSTED_SOCIAL_COUNTERPARTY_PROFILES.join(", ")}`,
    );
  }
  return {
    profile,
    source: input.builtConfig
      ? "build"
      : input.argv?.length > 0
        ? "argv"
        : "env",
  };
}

export function createHostedSocialCounterpartyPolicy(profile) {
  if (!HOSTED_SOCIAL_COUNTERPARTY_PROFILES.includes(profile)) {
    throw new Error(
      `unsupported hosted social counterparty profile: ${profile}`,
    );
  }
  const proposalAttempts = new Map();
  return function chooseHostedSocialCounterpartyDecision(input = {}) {
    const actions = stableActions(input.legalActions);
    const observation = input.observation ?? {};
    const primary = choosePrimary(profile, actions, observation);
    const deal =
      profile === "deal-blind"
        ? null
        : chooseDeal(profile, actions, observation, proposalAttempts);
    return {
      selectedLegalActionId: primary.id,
      ...(deal ? { selectedDealActionId: deal.id } : {}),
      reason: reasonFor(profile, primary, deal, observation),
      confidence: 1,
      fallbackUsed: false,
      llmPlannerDegraded: false,
    };
  };
}

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

function choosePrimary(profile, actions, observation) {
  const gameActions = actions.filter((action) => !DEAL_KINDS.has(action.kind));
  if (gameActions.length === 0) {
    throw new Error("decision_request contained no primary game action");
  }

  if (profile === "mutual-aid") {
    const support = supportFulfillment(gameActions, observation);
    if (support) return support;
    const alliance = alliancePrerequisite(gameActions, observation);
    if (alliance) return alliance;
  }

  if (profile === "pact-breaker") {
    const betrayal = deliberatePactBreach(gameActions, observation);
    if (betrayal) return betrayal;
  }

  const shouldSkip =
    profile === "pact-keeper" || profile === "mutual-aid"
      ? promisedHostilityFilter(observation)
      : () => false;
  return defaultPrimary(gameActions, shouldSkip);
}

function supportFulfillment(actions, observation) {
  const ownID = observation?.ownState?.playerID;
  if (!ownID) return null;
  for (const deal of activeDeals(observation)) {
    const obligation = ownPendingObligation(deal, ownID);
    if (obligation?.kind !== "send_support") continue;
    const partnerID = otherPartyID(deal, ownID);
    const goldRemaining = Math.max(
      0,
      Number(obligation.goldAmount ?? 0) - Number(obligation.donatedGold ?? 0),
    );
    const troopRemaining = Math.max(
      0,
      Number(obligation.troopAmount ?? 0) -
        Number(obligation.donatedTroops ?? 0),
    );
    const candidates = actions.filter(
      (action) =>
        action.metadata?.recipientID === partnerID &&
        (action.kind === "donate_gold" || action.kind === "donate_troops"),
    );
    const completing = candidates.find(
      (action) =>
        (action.kind === "donate_gold" &&
          goldRemaining > 0 &&
          Number(action.metadata?.gold ?? 0) >= goldRemaining) ||
        (action.kind === "donate_troops" &&
          troopRemaining > 0 &&
          Number(action.metadata?.troops ?? 0) >= troopRemaining),
    );
    if (completing) return completing;
    const progress = [...candidates].sort(
      (a, b) =>
        supportProgress(b, goldRemaining, troopRemaining) -
        supportProgress(a, goldRemaining, troopRemaining),
    )[0];
    if (
      progress &&
      supportProgress(progress, goldRemaining, troopRemaining) > 0
    ) {
      return progress;
    }
  }
  return null;
}

function supportProgress(action, goldRemaining, troopRemaining) {
  if (action.kind === "donate_gold" && goldRemaining > 0) {
    return Number(action.metadata?.gold ?? 0) / goldRemaining;
  }
  if (action.kind === "donate_troops" && troopRemaining > 0) {
    return Number(action.metadata?.troops ?? 0) / troopRemaining;
  }
  return 0;
}

function alliancePrerequisite(actions, observation) {
  const candidate = [...(observation.visiblePlayers ?? [])]
    .filter(
      (player) =>
        player?.playerID &&
        player.isAlive !== false &&
        player.isFriendly !== true,
    )
    .sort((a, b) => String(a.playerID).localeCompare(String(b.playerID)))[0];
  if (!candidate) return null;
  return (
    actions.find(
      (action) =>
        action.kind === "alliance_request" &&
        recipientID(action) === candidate.playerID,
    ) ?? null
  );
}

function deliberatePactBreach(actions, observation) {
  const ownID = observation?.ownState?.playerID;
  const step = observation?.deals?.decisionStep;
  if (!ownID || !Number.isInteger(step)) return null;
  for (const deal of activeDeals(observation)) {
    if (!NEGATIVE_TEMPLATES.has(deal.template)) continue;
    if (!ownPendingObligation(deal, ownID)) continue;
    if (!Number.isInteger(deal.activeFromStep) || step < deal.activeFromStep) {
      continue;
    }
    const partnerID = otherPartyID(deal, ownID);
    const hostile = actions.find((action) =>
      isHostileAgainst(action, partnerID),
    );
    if (hostile) return hostile;
  }
  return null;
}

function promisedHostilityFilter(observation) {
  const ownID = observation?.ownState?.playerID;
  const protectedIDs = new Set();
  if (ownID) {
    for (const deal of activeDeals(observation)) {
      if (
        NEGATIVE_TEMPLATES.has(deal.template) &&
        ownPendingObligation(deal, ownID)
      ) {
        protectedIDs.add(otherPartyID(deal, ownID));
      }
    }
  }
  return (action) =>
    [...protectedIDs].some((id) => isHostileAgainst(action, id));
}

function isHostileAgainst(action, playerID) {
  const targetID = action?.metadata?.targetID;
  if (targetID !== playerID) return false;
  return (
    action.kind === "attack" ||
    action.kind === "nuke" ||
    (action.kind === "boat" && Boolean(targetID)) ||
    (action.kind === "embargo" && action.metadata?.action === "start")
  );
}

function chooseDeal(profile, actions, observation, proposalAttempts) {
  const incoming = [...(observation?.deals?.incomingProposals ?? [])].sort(
    (a, b) =>
      (a.answerableThroughStep ?? 0) - (b.answerableThroughStep ?? 0) ||
      String(a.dealID).localeCompare(String(b.dealID)),
  );
  if (incoming.length > 0) {
    const proposal = incoming[0];
    const template = proposal?.terms?.template;
    const acceptsNegative = NEGATIVE_TEMPLATES.has(template);
    const acceptsSupport =
      template === "support_request" &&
      profile === "mutual-aid" &&
      trustedReciprocity(observation, proposal.proposerPlayerID) &&
      canHonorSupport(actions, observation, proposal);
    const kind =
      acceptsNegative || acceptsSupport ? "deal_accept" : "deal_reject";
    return responseAction(actions, proposal, kind);
  }

  const step = observation?.deals?.decisionStep;
  if (!Number.isInteger(step)) return null;
  const candidates = [...(observation.visiblePlayers ?? [])]
    .filter((player) => player?.playerID && player.isAlive !== false)
    .sort((a, b) => String(a.playerID).localeCompare(String(b.playerID)));

  for (const candidate of candidates) {
    if (
      profile === "mutual-aid" &&
      candidate.isFriendly === true &&
      step >= 18 &&
      needsSupport(observation, candidate) &&
      proposalAllowed(
        proposalAttempts,
        `${candidate.playerID}:support_request`,
        step,
        SUPPORT_RETRY_STEPS,
      )
    ) {
      const support = proposalAction(
        actions,
        candidate.playerID,
        "support_request",
      );
      if (support) {
        recordProposal(
          proposalAttempts,
          `${candidate.playerID}:support_request`,
          step,
        );
        return support;
      }
    }

    if (
      (candidate.sharesBorder === true || candidate.canAttack === true) &&
      step >= 4 &&
      !hasOpenDeal(observation, candidate.playerID, "non_aggression_pact") &&
      proposalAllowed(
        proposalAttempts,
        `${candidate.playerID}:non_aggression_pact`,
        step,
        PACT_RETRY_STEPS,
      )
    ) {
      const pact = proposalAction(
        actions,
        candidate.playerID,
        "non_aggression_pact",
      );
      if (pact) {
        recordProposal(
          proposalAttempts,
          `${candidate.playerID}:non_aggression_pact`,
          step,
        );
        return pact;
      }
    }
  }
  return null;
}

function trustedReciprocity(observation, playerID) {
  const evidence = (observation?.deals?.rivalReliability ?? []).find(
    (entry) => entry?.playerID === playerID,
  );
  const judged = Number(evidence?.terminalNonMoot ?? 0);
  const reliability = Number(evidence?.reliability);
  return judged > 0 && Number.isFinite(reliability) && reliability >= 0.5;
}

function canHonorSupport(actions, observation, proposal) {
  const proposer = (observation.visiblePlayers ?? []).find(
    (player) => player?.playerID === proposal.proposerPlayerID,
  );
  if (proposer?.isFriendly !== true) return false;
  const goldRequired = Number(proposal.terms?.goldAmount ?? 0);
  const troopsRequired = Number(proposal.terms?.troopAmount ?? 0);
  return actions.some(
    (action) =>
      (action.kind === "donate_gold" &&
        action.metadata?.recipientID === proposal.proposerPlayerID &&
        goldRequired > 0 &&
        Number(action.metadata?.gold ?? 0) >= goldRequired) ||
      (action.kind === "donate_troops" &&
        action.metadata?.recipientID === proposal.proposerPlayerID &&
        troopsRequired > 0 &&
        Number.isFinite(Number(proposer?.maxTroops)) &&
        Math.min(
          Number(action.metadata?.troops ?? 0),
          Math.max(
            0,
            Number(proposer.maxTroops) - Number(proposer.troops ?? 0),
          ),
        ) >= troopsRequired),
  );
}

function needsSupport(observation, partner) {
  const own = observation?.ownState ?? {};
  const ownShare = Number(own.tileShare ?? 0);
  const partnerShare = Number(partner.tileShare ?? 0);
  const troopRatio = Number(own.troopRatio ?? 1);
  return (
    Number(own.incomingAttacks ?? 0) > 0 ||
    (Number.isFinite(troopRatio) && troopRatio < 0.45) ||
    (Number.isFinite(ownShare) &&
      Number.isFinite(partnerShare) &&
      ownShare + 0.05 < partnerShare)
  );
}

function proposalAllowed(attempts, key, step, retrySteps) {
  const attempt = attempts.get(key);
  return (
    !attempt ||
    (attempt.count < MAX_ATTEMPTS_PER_KEY &&
      step - attempt.lastStep >= retrySteps)
  );
}

function recordProposal(attempts, key, step) {
  const attempt = attempts.get(key);
  attempts.set(key, { count: (attempt?.count ?? 0) + 1, lastStep: step });
}

function hasOpenDeal(observation, playerID, template) {
  const ownID = observation?.ownState?.playerID;
  if (
    (observation?.deals?.outgoingProposals ?? []).some(
      (proposal) =>
        proposal.recipientPlayerID === playerID &&
        proposal.terms?.template === template,
    )
  ) {
    return true;
  }
  return activeDeals(observation).some((deal) => {
    const otherID = otherPartyID(deal, ownID);
    return otherID === playerID && deal.template === template;
  });
}

function proposalAction(actions, playerID, template) {
  return (
    actions.find(
      (action) =>
        action.kind === "deal_propose" &&
        recipientID(action) === playerID &&
        action.metadata?.template === template,
    ) ?? null
  );
}

function responseAction(actions, proposal, kind) {
  return (
    actions.find(
      (action) =>
        action.kind === kind && action.metadata?.dealID === proposal?.dealID,
    ) ?? null
  );
}

function defaultPrimary(actions, shouldSkip) {
  const priorities = [
    (action) => action.kind === "spawn",
    (action) => action.kind === "alliance_accept",
    (action) => action.kind === "attack" && action.metadata?.expansion === true,
    (action) => action.kind === "build",
    (action) => action.kind === "upgrade_structure",
    (action) => action.kind === "boat" && !action.metadata?.targetID,
    (action) => action.kind === "attack",
    (action) => action.kind === "boat",
    (action) => action.kind === "hold",
  ];
  for (const matches of priorities) {
    const selected = actions.find(
      (action) =>
        matches(action) && action.risk?.level !== "high" && !shouldSkip(action),
    );
    if (selected) return selected;
  }
  return actions.find((action) => !shouldSkip(action)) ?? actions[0];
}

function activeDeals(observation) {
  return Array.isArray(observation?.deals?.activeDeals)
    ? observation.deals.activeDeals
    : [];
}

function ownPendingObligation(deal, ownID) {
  return (deal?.obligations ?? []).find(
    (obligation) =>
      obligation.obligorPlayerID === ownID && obligation.status === "pending",
  );
}

function otherPartyID(deal, ownID) {
  if (deal?.proposerPlayerID === ownID) return deal.recipientPlayerID;
  if (deal?.recipientPlayerID === ownID) return deal.proposerPlayerID;
  return null;
}

function recipientID(action) {
  return action?.metadata?.recipientID ?? action?.metadata?.targetID ?? null;
}

function reasonFor(profile, primary, deal, observation) {
  if (
    profile === "pact-breaker" &&
    deliberatePactBreach([primary], observation)
  ) {
    return `Eval pact-breaker intentionally violates an accepted promise with ${primary.kind}.`;
  }
  if (primary.kind === "donate_gold" || primary.kind === "donate_troops") {
    return `Eval mutual-aid counterparty fulfills earned reciprocal support with ${primary.kind}.`;
  }
  if (deal) {
    return `Eval ${profile} uses ${primary.kind} and exact ${deal.kind}.`;
  }
  return `Eval ${profile} uses ${primary.kind}; no eligible bounded deal action.`;
}
