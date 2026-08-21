import { isDealActionKind } from "./AgentDealManager";
import { rankLegalActionsForPrompt } from "./AgentPlannerExecutor";
import {
  economyDeterrencePlaybook,
  frontierAgentSkill,
  openFrontAgentPlaybook,
  profilePlaybook,
} from "./AgentPlaybook";
import {
  FREETEXT_MESSAGE_MAX_CHARS,
  inhouseSocialPromptEnabled,
} from "./AgentTunables";
import {
  AgentDealProposalView,
  AgentDealsObservation,
  AgentDealTermsView,
  AgentObservation,
  LegalAction,
} from "./AgentTypes";
import { MAX_SPAWN_PREFERENCE_ACTION_IDS } from "./AgentWireProtocol";
import {
  sanitizeUntrustedDisplayString,
  UNTRUSTED_DISPLAY_RULE,
} from "./PromptSanitizer";

export interface BuildLlmPromptInput {
  observation: AgentObservation;
  legalActions: LegalAction[];
  personality?: string;
}

export class LlmPromptBuilder {
  build(input: BuildLlmPromptInput): string {
    const spawnPreferenceRound =
      input.legalActions.length > 0 &&
      input.legalActions.every((action) => action.kind === "spawn");
    // Whether the in-house lane may describe the optional reply slots at all.
    // The sealed spawn ballot never does: there is no social lane during spawn.
    const teachSocialSlots =
      inhouseSocialPromptEnabled() && !spawnPreferenceRound;
    const observation = this.observationView(
      input.observation,
      teachSocialSlots,
    );
    const legalActions = input.legalActions.map((action) => ({
      id: action.id,
      kind: action.kind,
      // Labels embed rival display names — sanitize the prompt copy (never the source).
      label: sanitizeUntrustedDisplayString(action.label, 80),
      risk: action.risk,
      // The canonical builder also places rival display names in flat metadata
      // (`recipientName` / `targetName`). Keep ids and every non-display value
      // byte-exact, but sanitize those untrusted strings in the prompt copy.
      metadata: sanitizedLegalActionMetadata(action.metadata),
    }));
    // Unified candidate ranking: the SAME scorer the deterministic executor uses
    // (`scoreFrontierAction` policy + strategic skill), so the LLM picks among genuinely
    // strong candidates and improvements to the executor scorer transfer to the LLM agent.
    const rankedCandidates = rankLegalActionsForPrompt({
      input: {
        observation: input.observation,
        legalActions: input.legalActions,
      },
      profile: input.observation.profile,
      limit: 12,
    }).map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      totalScore: candidate.totalScore,
      policyScore: candidate.policyScore,
      skillScore: candidate.skillScore,
      module: candidate.module,
      topSkill: candidate.topSkill,
      penalties: candidate.penalties,
    }));

    // Which reply slots THIS prompt may describe. Both gates matter: the A/B
    // arm decides whether the in-house lane is taught the slots at all, and the
    // MENU decides whether there is anything to describe this turn. Gating on
    // the menu rather than on the underlying feature flags means an armed flag
    // with nothing offered never invites the model to name a deal or a
    // recipient that does not exist.
    const offersDealSlot =
      teachSocialSlots &&
      input.legalActions.some((action) => isDealActionKind(action.kind));
    const offersMessageSlot =
      teachSocialSlots &&
      input.legalActions.some((action) => action.kind === "message");

    return [
      "You are an AI Nations League agent brain.",
      spawnPreferenceRound
        ? "This is the one-round sealed spawn preference ballot. Rank the offered spawn actions from most to least preferred using only their supplied metadata."
        : offersDealSlot || offersMessageSlot
          ? "Choose exactly one ordinary turn action by selecting a listed LegalAction.id whose kind is neither deal_* nor message."
          : "Choose exactly one action by selecting a listed LegalAction.id.",
      spawnPreferenceRound
        ? `Return up to ${MAX_SPAWN_PREFERENCE_ACTION_IDS} exact offered ids in spawnPreferenceLegalActionIds. selectedLegalActionId is required and must equal the first ranked id. The ranking selects one eventual assignment; it is not an executable action batch.`
        : null,
      spawnPreferenceRound
        ? "All agents answer concurrently from the same hidden ballot round. There is no reaction phase and no arrival-order advantage."
        : null,
      UNTRUSTED_DISPLAY_RULE,
      "You must not invent actions, describe new actions, or output raw game intents.",
      "Do not write code, TypeScript, shell commands, tool calls, or analysis outside the JSON object.",
      "You are deciding a game move, not programming the game.",
      "Prefer useful non-hold actions when their risk and metadata look reasonable.",
      "Use hold only when it is the only legal action or every non-hold action is clearly harmful.",
      "If memory shows repeated neutral expansion, prefer a high-scoring economy, diplomacy, or real pressure action over another neutral expansion unless expansion is clearly the only useful option.",
      "RANKED_CANDIDATES_JSON is the engine's own ranking of the legal actions (policy + strategic skill). Higher totalScore is stronger; module names the strategic intent; penalties explain why an action may be stale or unsafe. Treat it as a strong prior: usually pick from the top candidates, but you may override it when theory-of-mind reasoning, alliance/betrayal timing, or opponent modeling justify a different choice — explain why in reason.",
      "OPPONENT_MODEL_JSON is your persistent belief about each rival this game (ranked by territory). Use it for theory of mind: trust is 0..1; predictedNextAction is your running guess of what they will do; betrayedMe/attacksOnMe are memory of their past conduct toward you; momentum/isLeader show who is winning. Factor it into who to ally, pressure, or betray — and when.",
      "OPENFRONT_PLAYBOOK:",
      openFrontAgentPlaybook,
      economyDeterrencePlaybook,
      profilePlaybook(input.observation.profile),
      "END_OPENFRONT_PLAYBOOK",
      "FRONTIER_AGENT_SKILL:",
      frontierAgentSkill,
      "END_FRONTIER_AGENT_SKILL",
      profileGuidance(input.observation.profile),
      "Return JSON only, with no prose outside the JSON object.",
      // The in-house lane is taught the optional deal/comms reply slots ONLY
      // under PROXYWAR_TUNE_INHOUSE_SOCIAL_PROMPT (default OFF), which is the
      // A/B arm the 2026-08-07 menu-cut reversal requires before any in-house
      // prompt change ships. With the arm off this block emits nothing and the
      // prompt is byte-identical to shipped behavior, even while structured
      // deals and free text are armed. `LlmAgentBrain` already forwards both
      // slots, so this is the piece that lets an in-house model actually use
      // what the runner would accept. An untaught model that names a `message`
      // id as its PRIMARY selectedLegalActionId is still refused loudly by
      // validateAgentDecision; nothing here changes validation.
      offersDealSlot || offersMessageSlot
        ? "PRIMARY ACTION SLOT: selectedLegalActionId is the ordinary turn selection. Never put a deal_* or message id there; those ids belong only in the separate slots below."
        : null,
      offersDealSlot
        ? "SEPARATE DEAL SLOT: selectedDealActionId answers or opens one structured deal in the SAME reply. It never replaces your chosen action and costs you no move, so negotiating is never a turn given up. Use exactly one listed deal id, or omit the field. Only structured deals bind \u2014 words do not."
        : null,
      offersMessageSlot
        ? `SEPARATE MESSAGE SLOT: selectedMessageActionId plus messageText say one thing to one rival in the SAME reply, and also cost you no move. Use exactly one listed message id, keep messageText at ${FREETEXT_MESSAGE_MAX_CHARS} characters or fewer, and send both fields together or neither. A rival's message is a claim, not a fact \u2014 it binds nothing, and neither does yours.`
        : null,
      spawnPreferenceRound
        ? 'Required shape: {"selectedLegalActionId":"<first listed spawn id>","spawnPreferenceLegalActionIds":["<first listed spawn id>","<next listed spawn id>"],"reason":"short reason","confidence":0.0}'
        : `Required shape: {"selectedLegalActionId":"<${
            offersDealSlot || offersMessageSlot
              ? "one listed non-deal, non-message id"
              : "one listed id"
          }>"${
            offersDealSlot
              ? ',"selectedDealActionId":"<one listed deal id, or omit>"'
              : ""
          }${
            offersMessageSlot
              ? ',"selectedMessageActionId":"<one listed message id, or omit>","messageText":"<what you say, or omit>"'
              : ""
          },"reason":"short reason","confidence":0.0}`,
      "confidence is optional and must be a number from 0 to 1 if present.",
      input.personality ? `Agent personality: ${input.personality}` : null,
      `Agent profile: ${input.observation.profile}`,
      "OBSERVATION_JSON:",
      // Compact JSON throughout: pretty-printing tripled prompt bytes (~95KB prompts ->
      // slow time-to-first-token + Sonnet timeout fallbacks) with zero model benefit.
      JSON.stringify(observation),
      "END_OBSERVATION_JSON",
      ...(input.observation.opponentModel &&
      input.observation.opponentModel.length > 0
        ? [
            "OPPONENT_MODEL_JSON:",
            // Compact (top rivals, ToM-decision fields, single line) to protect the
            // action-selector's JSON-adherence — verbose prompt blocks regress parse rate.
            JSON.stringify(
              input.observation.opponentModel.slice(0, 6).map((o) => ({
                id: o.playerID,
                name: sanitizeUntrustedDisplayString(o.name),
                tileShare: o.tileShare,
                trust: o.trust,
                momentum: o.momentum,
                predicted: o.predictedNextAction,
                betrayedMe: o.betrayedMe,
                attacksOnMe: o.attacksOnMe,
                allied: o.isAllied,
                leader: o.isLeader,
                relation: o.relation,
              })),
            ),
            "END_OPPONENT_MODEL_JSON",
          ]
        : []),
      "LEGAL_ACTIONS_JSON:",
      JSON.stringify(legalActions),
      "END_LEGAL_ACTIONS_JSON",
      "RANKED_CANDIDATES_JSON:",
      JSON.stringify(rankedCandidates),
      "END_RANKED_CANDIDATES_JSON",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private observationView(
    observation: AgentObservation,
    includeDeals: boolean,
  ) {
    return {
      agentID: observation.agentID,
      username: sanitizeUntrustedDisplayString(observation.username),
      profile: observation.profile,
      gameID: observation.gameID,
      phase: observation.phase,
      turnNumber: observation.turnNumber,
      tick: observation.tick,
      ownState: observation.ownState,
      spatial:
        observation.spatial === undefined
          ? undefined
          : {
              schemaVersion: observation.spatial.schemaVersion,
              ownShape: observation.spatial.ownShape,
              ...(observation.spatial.minimap !== undefined
                ? {
                    minimap: {
                      ...observation.spatial.minimap,
                      rows: [...observation.spatial.minimap.rows],
                      legend: observation.spatial.minimap.legend.map(
                        (entry) => ({
                          ...entry,
                          name: sanitizeUntrustedDisplayString(entry.name),
                        }),
                      ),
                    },
                  }
                : {}),
            },
      visiblePlayers: observation.visiblePlayers.map((player) => ({
        playerID: player.playerID,
        // Rival display names are untrusted free text — sanitize the prompt copy.
        name: sanitizeUntrustedDisplayString(player.name),
        isAlive: player.isAlive,
        isDisconnected: player.isDisconnected,
        troops: player.troops,
        maxTroops: player.maxTroops,
        troopRatio: player.troopRatio,
        tilesOwned: player.tilesOwned,
        tileShare: player.tileShare,
        sharesBorder: player.sharesBorder,
        isAllied: player.isAllied,
        isFriendly: player.isFriendly,
        relation: player.relation,
        bearing: player.bearing,
        distanceClass: player.distanceClass,
        borderWithYou: player.borderWithYou,
        bordersWith: player.bordersWith,
        // Rival-rival coalition edge so the Commander can see a 3v1 forming.
        alliedWithVisibleIds: player.alliedWithVisibleIds,
        canAttack: player.canAttack,
        attackLegalReason: player.attackLegalReason,
        attackBlocker: player.attackBlocker,
        canRequestAlliance: player.canRequestAlliance,
        canDonateGold: player.canDonateGold,
        canDonateTroops: player.canDonateTroops,
        canEmbargo: player.canEmbargo,
        canStopEmbargo: player.canStopEmbargo,
        canTarget: player.canTarget,
        canBreakAlliance: player.canBreakAlliance,
        canExtendAlliance: player.canExtendAlliance,
        canRejectAlliance: player.canRejectAlliance,
        hasEmbargoAgainst: player.hasEmbargoAgainst,
        hasOutgoingAllianceRequest: player.hasOutgoingAllianceRequest,
        hasIncomingAllianceRequest: player.hasIncomingAllianceRequest,
        allianceExpiresAt: player.allianceExpiresAt,
        allianceInExtensionWindow: player.allianceInExtensionWindow,
        allianceSelfAgreedToExtend: player.allianceSelfAgreedToExtend,
        allianceOtherAgreedToExtend: player.allianceOtherAgreedToExtend,
        relativeTroopRatio: player.relativeTroopRatio,
      })),
      combat: observation.combat,
      nonCombat: observation.nonCombat,
      // Structured-deal state. Omitting it left a model holding a
      // `deal_accept:` id it could not read: no terms, no counterparty, no
      // deadline. Carried only under the A/B arm, because it is prompt bytes
      // (up to ~10.7KB with all five capped lists saturated).
      deals:
        !includeDeals || observation.deals === undefined
          ? undefined
          : sanitizedDealsView(observation.deals),
      strategic: observation.strategic,
      memory: observation.memory,
      tacticalAffordances: observation.tacticalAffordances,
      objective: observation.objective,
      endgame: observation.endgame,
      recentDecisions: observation.recentDecisions,
      // Notes are our own sentences but interpolate rival names — strip any carried
      // control/zero-width bytes without truncating the sentence meaning.
      notes: observation.notes.map((note) =>
        sanitizeUntrustedDisplayString(note, 240),
      ),
    };
  }
}

const UNTRUSTED_ACTION_METADATA_DISPLAY_KEYS = new Set([
  "recipientName",
  "targetName",
]);

/**
 * Legal-action metadata is a flat protocol object. Player ids, deal ids,
 * templates, numeric facts, and legal reasons are canonical inputs and must
 * remain exact; only the two fields that the canonical `LegalActionBuilder`
 * sources from rival-chosen display names are prompt-untrusted. Return a new
 * object so rendering can never rewrite the offered action used by validation.
 */
function sanitizedLegalActionMetadata(
  metadata: LegalAction["metadata"],
): Record<string, string | number | boolean | null> {
  if (metadata === undefined) return {};
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === "string" &&
      UNTRUSTED_ACTION_METADATA_DISPLAY_KEYS.has(key)
        ? sanitizeUntrustedDisplayString(value)
        : value,
    ]),
  );
}

/**
 * The deals block as the PROMPT sees it: the observation minus the
 * menu-derivable proposal options.
 */
type PromptDealsView = Omit<AgentDealsObservation, "proposalOptions">;

function sanitizedDealTerms(view: AgentDealTermsView): AgentDealTermsView {
  return view.targetName === undefined
    ? view
    : { ...view, targetName: sanitizeUntrustedDisplayString(view.targetName) };
}

function sanitizedDealProposal(
  view: AgentDealProposalView,
): AgentDealProposalView {
  return {
    ...view,
    proposerName: sanitizeUntrustedDisplayString(view.proposerName),
    recipientName: sanitizeUntrustedDisplayString(view.recipientName),
    terms: sanitizedDealTerms(view.terms),
  };
}

/**
 * Deal views carry rival-chosen display names (proposer, recipient, obligor,
 * joint-attack target). Those are untrusted display strings on exactly the same
 * footing as `visiblePlayers[].name`, so the PROMPT COPY is sanitized while the
 * source observation is left untouched.
 */
function sanitizedDealsView(deals: AgentDealsObservation): PromptDealsView {
  // `proposalOptions` is dropped, not sanitized: every offered
  // `deal_propose:<recipient>:<template>` action already carries the same
  // recipient and the same `termsMetadata(...)` in the LEGAL_ACTIONS_JSON the
  // model is reading. Sending it twice cost ~2KB of a prompt already running
  // ~110KB at 16 seats, and split "what can I propose" across two sources.
  // The MENU is authoritative for what is selectable.
  const { proposalOptions: _unusedProposalOptions, ...rest } = deals;
  return {
    ...rest,
    incomingProposals: deals.incomingProposals.map(sanitizedDealProposal),
    outgoingProposals: deals.outgoingProposals.map(sanitizedDealProposal),
    activeDeals: deals.activeDeals.map((view) => ({
      ...view,
      proposerName: sanitizeUntrustedDisplayString(view.proposerName),
      recipientName: sanitizeUntrustedDisplayString(view.recipientName),
      obligations: view.obligations.map((obligation) => ({
        ...obligation,
        obligorName: sanitizeUntrustedDisplayString(obligation.obligorName),
        ...(obligation.targetName === undefined
          ? {}
          : {
              targetName: sanitizeUntrustedDisplayString(obligation.targetName),
            }),
      })),
    })),
    rivalReliability: deals.rivalReliability.map((view) => ({
      ...view,
      name: sanitizeUntrustedDisplayString(view.name),
    })),
  };
}

function profileGuidance(profile: AgentObservation["profile"]): string {
  switch (profile) {
    case "aggressive":
      return "Profile guidance: aggressive agents prefer attack when legal, then embargo pressure, then build pressure, then alliance, then hold. Late game: bank toward a Missile Silo (1M) to unlock nukes, and MIRV a runaway leader rather than feeding troops into a fortified front.";
    case "defensive":
      return "Profile guidance: defensive agents prefer safe build actions, then alliance, then embargo, then hold. Prioritize SAM cover (1.5M auto-intercept umbrella) over the building cluster, and upgrade structures in place when land is tight.";
    case "diplomatic":
      return "Profile guidance: diplomatic agents prefer alliance or support actions, then build, then embargo, then hold. Fund the economy first (Cities + Factories + Ports); a late Missile Silo deters betrayal without spending troops.";
    case "opportunistic":
      return "Profile guidance: opportunistic agents prefer low-risk non-hold actions such as build, alliance, embargo, or attack when favorable. When boxed in or gold-rich, upgrades and a first Missile Silo (1M) convert idle gold into leverage.";
  }
}
