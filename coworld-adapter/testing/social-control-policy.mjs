/**
 * Deterministic policies for the ProxyWar social-evidence experiment.
 *
 * These controls never invent an intent or action id. They select one offered
 * primary LegalAction.id and, only in the active arm, at most one offered
 * deal_* id for the optional diplomacy slot.
 */

export const SOCIAL_CONTROL_PROFILES = [
  "keeper",
  "defector",
  "skeptic",
  "deal-blind",
];

export const SOCIAL_CONTROL_ARMS = ["off", "ignored", "active"];

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

/**
 * Resolve the immutable experiment identity. A build-stamped config always
 * wins over argv and environment so hosted runtime overrides cannot silently
 * change the frozen profile or arm.
 */
export function resolveSocialControlConfig(input = {}) {
  const built = input.builtConfig;
  const argv = input.argv ?? [];
  const env = input.env ?? {};
  const profile =
    built?.profile ?? argv[0] ?? env.PROXYWAR_SOCIAL_CONTROL_POLICY;
  const arm = built?.arm ?? argv[1] ?? env.PROXYWAR_SOCIAL_CONTROL_ARM;
  return {
    profile: checkedValue(profile, SOCIAL_CONTROL_PROFILES, "profile"),
    arm: checkedValue(arm, SOCIAL_CONTROL_ARMS, "arm"),
    source: built ? "build" : argv.length > 0 ? "argv" : "env",
  };
}

export function chooseSocialControlDecision(input) {
  const profile = checkedValue(
    input?.profile,
    SOCIAL_CONTROL_PROFILES,
    "profile",
  );
  const arm = checkedValue(input?.arm, SOCIAL_CONTROL_ARMS, "arm");
  const actions = stableActions(input?.legalActions);
  const observation = input?.observation ?? {};
  const primary = choosePrimaryAction({ profile, arm, actions, observation });
  const deal =
    arm === "active"
      ? chooseDealAction({ profile, actions, observation })
      : null;

  return {
    selectedLegalActionId: primary.id,
    ...(deal ? { selectedDealActionId: deal.id } : {}),
    reason: decisionReason({ profile, arm, primary, deal, observation }),
    confidence: 1,
    fallbackUsed: false,
    llmPlannerDegraded: false,
  };
}

function checkedValue(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value;
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

function isDealAction(action) {
  return DEAL_KINDS.has(action.kind);
}

function choosePrimaryAction({ profile, arm, actions, observation }) {
  const gameActions = actions.filter((action) => !isDealAction(action));
  if (gameActions.length === 0) {
    throw new Error("decision_request contained no primary game action");
  }

  // OFF and ignored must be behaviorally identical. Profile-specific game
  // behavior activates only in the active arm after a structured promise
  // exists, so the three arms differ only by the social treatment.
  if (arm === "active" && profile === "keeper") {
    const fulfillment = keeperFulfillment(gameActions, observation);
    if (fulfillment) return fulfillment;
    if (hasOwnNegativeObligation(observation)) {
      const hold = gameActions.find((action) => action.kind === "hold");
      if (hold) return hold;
    }
    return defaultPrimary(gameActions, keeperPromiseFilter(observation));
  }

  if (arm === "active" && profile === "defector") {
    const betrayal = deliberateBetrayal(gameActions, observation);
    if (betrayal) return betrayal;
    if (hasOwnNegativeObligation(observation)) {
      const hold = gameActions.find((action) => action.kind === "hold");
      if (hold) return hold;
    }
  }

  return defaultPrimary(gameActions, () => false);
}

function keeperFulfillment(actions, observation) {
  const ownID = observation?.ownState?.playerID;
  if (!ownID) return null;

  for (const deal of activeDeals(observation)) {
    const obligation = ownPendingObligation(deal, ownID);
    if (!obligation) continue;

    if (obligation.kind === "send_support") {
      const recipientID = otherPartyID(deal, ownID);
      const donations = actions.filter(
        (action) =>
          (action.kind === "donate_gold" || action.kind === "donate_troops") &&
          action.metadata?.recipientID === recipientID,
      );
      const selected = highestDonation(donations);
      if (selected) return selected;
    }

    if (
      obligation.kind === "confirmed_attack_on_target" &&
      obligation.targetPlayerID
    ) {
      const pressure = actions.find(
        (action) =>
          action.metadata?.targetID === obligation.targetPlayerID &&
          (action.kind === "nuke" ||
            (action.kind === "attack" &&
              action.metadata?.expansion !== true &&
              troopFraction(action) >= 0.2)),
      );
      if (pressure) return pressure;
    }
  }
  return null;
}

function highestDonation(actions) {
  return [...actions].sort((a, b) => {
    const amount = (action) =>
      action.kind === "donate_gold"
        ? Number(action.metadata?.gold ?? 0)
        : Number(action.metadata?.troops ?? 0);
    return amount(b) - amount(a) || a.id.localeCompare(b.id);
  })[0];
}

function troopFraction(action) {
  if (typeof action.metadata?.troopPercentage === "number") {
    return action.metadata.troopPercentage;
  }
  if (typeof action.metadata?.troopPercent === "number") {
    return action.metadata.troopPercent / 100;
  }
  return 0;
}

function keeperPromiseFilter(observation) {
  const ownID = observation?.ownState?.playerID;
  const noAttack = new Set();
  const noEmbargo = new Set();
  if (!ownID) return () => false;

  for (const deal of activeDeals(observation)) {
    if (!NEGATIVE_TEMPLATES.has(deal.template)) continue;
    if (!ownPendingObligation(deal, ownID)) continue;
    const partnerID = otherPartyID(deal, ownID);
    if (!partnerID) continue;
    noAttack.add(partnerID);
    if (deal.template === "trade_security_pact") noEmbargo.add(partnerID);
  }

  return (action) => {
    const targetID = action.metadata?.targetID;
    if (
      (action.kind === "attack" ||
        action.kind === "nuke" ||
        (action.kind === "boat" && targetID)) &&
      noAttack.has(targetID)
    )
      return true;
    if (
      action.kind === "embargo" &&
      action.metadata?.action === "start" &&
      noEmbargo.has(targetID)
    )
      return true;
    return action.kind === "embargo_all" && noEmbargo.size > 0;
  };
}

function deliberateBetrayal(actions, observation) {
  const ownID = observation?.ownState?.playerID;
  const decisionStep = observation?.deals?.decisionStep;
  if (!ownID || !Number.isInteger(decisionStep)) return null;

  for (const deal of activeDeals(observation)) {
    if (!NEGATIVE_TEMPLATES.has(deal.template)) continue;
    if (!ownPendingObligation(deal, ownID)) continue;
    if (
      !Number.isInteger(deal.activeFromStep) ||
      decisionStep < deal.activeFromStep
    )
      continue;
    const partnerID = otherPartyID(deal, ownID);
    const hostile = actions.find(
      (action) =>
        action.metadata?.targetID === partnerID &&
        (action.kind === "attack" ||
          action.kind === "nuke" ||
          (action.kind === "boat" && action.metadata?.targetID) ||
          (action.kind === "embargo" && action.metadata?.action === "start")),
    );
    if (hostile) return hostile;
    if (deal.template === "trade_security_pact") {
      const embargoAll = actions.find(
        (action) =>
          action.kind === "embargo_all" && action.metadata?.action === "start",
      );
      if (embargoAll) return embargoAll;
    }
  }
  return null;
}

function chooseDealAction({ profile, actions, observation }) {
  if (profile === "deal-blind") return null;

  const incoming = [...(observation?.deals?.incomingProposals ?? [])].sort(
    (a, b) => String(a.dealID).localeCompare(String(b.dealID)),
  );
  if (profile === "skeptic") {
    return responseAction(actions, incoming[0], "deal_reject");
  }

  for (const proposal of incoming) {
    if (
      profile === "keeper" ||
      NEGATIVE_TEMPLATES.has(proposal?.terms?.template)
    ) {
      const accept = responseAction(actions, proposal, "deal_accept");
      if (accept) return accept;
    }
  }

  if (profile === "defector" && incoming.length > 0) {
    const decline = responseAction(actions, incoming[0], "deal_reject");
    if (decline) return decline;
  }

  // The frozen keeper and defector must actually encounter one another in the
  // heterogeneous control roster. Stable ID sorting otherwise targets the
  // skeptic first, producing only rejection/withdrawal loops and no accepted
  // commitments to measure.
  const preferredRecipientName =
    profile === "keeper"
      ? "Social defector"
      : profile === "defector"
        ? "Social keeper"
        : null;
  const proposal = actions.find(
    (action) =>
      action.kind === "deal_propose" &&
      action.metadata?.template === "trade_security_pact" &&
      (preferredRecipientName === null ||
        action.metadata?.recipientName === preferredRecipientName),
  );
  if (proposal) return proposal;

  // Do not silently substitute another promise template when the frozen
  // trade-security control is temporarily unavailable. That would change the
  // obligation being measured: an embargo violates trade security but can
  // fulfill a non-aggression pact. Withdrawing an old proposal (or abstaining)
  // keeps the control policy aligned with its preregistered construct.
  return actions.find((action) => action.kind === "deal_withdraw") ?? null;
}

function responseAction(actions, proposal, kind) {
  if (!proposal?.dealID) return null;
  return (
    actions.find(
      (action) =>
        action.kind === kind && action.metadata?.dealID === proposal.dealID,
    ) ?? null
  );
}

function defaultPrimary(actions, shouldSkip) {
  const priorities = [
    (action) => action.kind === "spawn",
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

function hasOwnNegativeObligation(observation) {
  const ownID = observation?.ownState?.playerID;
  if (!ownID) return false;
  return activeDeals(observation).some((deal) => {
    const obligation = ownPendingObligation(deal, ownID);
    return (
      obligation?.kind === "non_aggression" ||
      obligation?.kind === "trade_security"
    );
  });
}

function otherPartyID(deal, ownID) {
  if (deal?.proposerPlayerID === ownID) return deal.recipientPlayerID;
  if (deal?.recipientPlayerID === ownID) return deal.proposerPlayerID;
  return null;
}

function decisionReason({ profile, arm, primary, deal, observation }) {
  if (arm !== "active") {
    return `Control ${profile} baseline: game action ${primary.kind}; diplomacy omitted.`;
  }
  if (profile === "defector" && deliberateBetrayal([primary], observation)) {
    return `Control defector intentionally breaks an active promise with ${primary.kind}.`;
  }
  if (deal?.kind === "deal_accept") {
    return `Control ${profile} accepts the offered promise; game action ${primary.kind} continues.`;
  }
  if (deal?.kind === "deal_reject") {
    return `Control ${profile} declines the offered promise; game action ${primary.kind} continues.`;
  }
  if (deal?.kind === "deal_propose") {
    return `Control ${profile} offers a structured promise; game action ${primary.kind} continues.`;
  }
  return `Control ${profile} active arm: game action ${primary.kind}; no diplomacy selection.`;
}
