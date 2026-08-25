// Proxy War Coworld KEYSTONE policy player.
//
// Runs the in-house Commander–Executor v2 agent (PlannerExecutorAgentBrain with
// binding directives) as a Coworld websocket policy. The decision path is the
// canonical one: the game offers AgentObservation + LegalAction[] over the
// /player websocket and this player only ever answers with one offered
// LegalAction.id — the game side re-validates through AgentDecisionValidator.
// No raw intents, no second validator, no new runner.
//
// In-clock guarantee: hosted Bedrock Commander refreshes are awaited only on
// the bounded planning cadence, under one <=12s aggregate provider deadline;
// executor decisions between refreshes remain immediate and provider-free.
// This makes each actual Bedrock call terminal and response-correlated instead
// of leaving an unbounded background refresh whose evidence lands on a later
// request. Local Claude CLI mode retains DeferredAgentPlanner because its
// subscription transport is not the hosted/cost-accounted lane.
//
// Action batching (since the game image advertising protocol.maxActionsPerDecision):
// the decision_request envelope tells us how many actions the wire will carry.
// When it advertises >= 2 we emit the executor's existing cascade as
// selectedLegalActionIds (scalar primary first); when it does not — an older
// game image — we degrade to the primary and say so in the reason, exactly as
// before. Anything the advertised cap cannot carry keeps that honest note.
// Spawn ranking is a separate capability (`protocol.maxSpawnPreferences`):
// an all-spawn menu is ranked locally from offered metadata and returned as
// `spawnPreferenceLegalActionIds`. It bypasses the Commander/executor entirely,
// so the pre-game ballot neither refreshes a plan nor enters gameplay history.
//
// Modes (PROXYWAR_KEYSTONE_MODE; DEFAULT = the LLM Commander — bedrock when
// USE_BEDROCK=true, otherwise claude-cli; "the agent" IS the LLM brain):
//   claude-cli local default — Claude CLI subscription via AI_LEAGUE_CLAUDE_*.
//              Fails loud if the CLI is missing/logged out (no silent rule bot).
//   bedrock    hosted default under --use-bedrock pods (USE_BEDROCK=true) —
//              Claude on Bedrock, inference on Softmax's service account
//              (payer confirmed 2026-06-10).
//   mock       MockLlmPlanner protocol-test plumbing only. Never a seat.
//
// There is deliberately NO deterministic/executor mode. Operator rule
// (2026-06-10, permanent): never run, default to, or suggest a deterministic
// executor as the agent or a seat. LLM failures must be loud (thrown or
// llmPlannerDegraded on the wire), never silently absorbed by a rule bot.
//
// Env (all optional unless noted):
//   COWORLD_PLAYER_WS_URL        required at runtime (set by the platform)
//   PROXYWAR_REPO                repo root inside the pod (default /app/proxywar)
//   PROXYWAR_KEYSTONE_MODE       see above (default: LLM Commander)
//   PROXYWAR_KEYSTONE_PROFILE    strategy profile (default "aggressive")
//   PROXYWAR_KEYSTONE_PLAN_EVERY Commander cadence in decision steps (default 3)
//   PROXYWAR_LLM_MODEL_ID / AWS_REGION / PROXYWAR_LLM_TIMEOUT_MS  bedrock mode

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  commanderExecutionEnvelope,
  MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
  normalizeDegradedCause,
  normalizeProviderEvidence,
  normalizeRuntimeMode,
  type CoworldProviderEvidence,
} from "./coworld-decision-wire";

import type {
  AgentPlanDecision,
  AgentPlanner,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentObservation,
  AgentStrategyProfile,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";
import {
  generateOpenEndedMessage,
  OPEN_ENDED_MESSAGE_MAX_CHARS,
  type OpenEndedMessageIntent,
} from "../commander-starter/open-ended-message";

type PlannerExecutorModule =
  typeof import("../../src/server/agents/AgentPlannerExecutor");
type ClaudeCliModule =
  typeof import("../../src/server/agents/ClaudeCliLlmProvider");

export interface KeystoneModules {
  plannerExecutor: PlannerExecutorModule;
  claudeCli: ClaudeCliModule;
}

export type KeystoneMode = "mock" | "claude-cli" | "bedrock";

export interface KeystoneBrainOptions {
  mode: KeystoneMode;
  profile: AgentStrategyProfile;
  planEveryDecisionSteps?: number;
  providerTimeoutMs?: number;
  /** Override the LLM provider (tests / future transports). */
  provider?: LlmProvider;
  /** Inject the hosted Bedrock handle without bypassing its evidence recorder. */
  bedrockProviderHandle?: KeystoneBedrockProviderHandle;
  /** Main owns the evidence window when social generation shares the provider. */
  deferProviderEvidence?: boolean;
  /**
   * Force a local Claude-CLI Commander onto the synchronous refresh path.
   * Hosted Bedrock is always synchronous on refresh decisions so provider
   * evidence is terminal and correlated to the response that incurred it.
   * Pair with planEveryDecisionSteps=1 only for a diagnostic.
   */
  blocking?: boolean;
}

// Mirrors the league-smoke planner-claude-cli executor settings so local play
// and the Coworld seat run the same tuned executor.
const KEYSTONE_EXECUTOR_SETTINGS = {
  territoryFirstNeutralLandEnabled: true,
  maxActionsPerDecision: 5,
  siloTileShareRatio: 0.14,
  samTileShareRatio: 0.14,
} as const;

/**
 * Keystone behavior-flag env plumbing (K1/K2 of plan keen-sparking-hollerith).
 * The executor reads these `PROXYWAR_TUNE_*` variables directly from process.env
 * at decision time (src/server/agents/AgentTunables.ts), and keystone-player runs
 * the executor in-process — so a hosted pod env carrying any of these reaches the
 * policy with no further wiring. DEFAULTS ALL OFF IN CODE: nothing here (or in the
 * repo defaults) sets a value, so the hosted policy ships inert and an arm is
 * enabled later via the pod env only after the local forge A/B verdict. The
 * explicit allowlist + boot-log summary exist so which arm a pod ran is auditable
 * from its logs instead of inferred.
 */
/** One-line boot-log summary of which keystone behavior flags the pod env set —
 *  "tunables=defaults" when none are, i.e. the shipped all-off configuration.
 *  Scans the PROXYWAR_TUNE_ prefix rather than an allowlist: the executor reads
 *  ~30 tunables (booleans in AgentTunables.ts plus tunedNumber numerics), and a
 *  stale allowlist meant a pod could run non-default behavior while logging
 *  "tunables=defaults" — defeating the audit purpose of this line. */
export function keystoneTunableFlagSummary(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const set = Object.keys(env)
    .filter(
      (name) =>
        name.startsWith("PROXYWAR_TUNE_") && (env[name] ?? "").trim() !== "",
    )
    .sort()
    .map((name) => `${name}=${env[name]?.trim()}`);
  return set.length === 0 ? "tunables=defaults" : `tunables=[${set.join(",")}]`;
}

const RESPONSE_REASON_MAX_LENGTH = 500;
export const KEYSTONE_PROVIDER_BUDGET_MAX_MS = 12_000;

/**
 * The provider budget is the whole refresh budget, not a per-model timeout.
 * Candidate fallback and the planner's optional repair call share it. The
 * 250ms floor matches the direct starter and avoids a zero/negative timeout
 * silently becoming an SDK default.
 */
export function boundedKeystoneProviderBudgetMs(value: unknown): number {
  const parsed = Number(value ?? KEYSTONE_PROVIDER_BUDGET_MAX_MS);
  if (!Number.isSafeInteger(parsed)) return KEYSTONE_PROVIDER_BUDGET_MAX_MS;
  return Math.min(KEYSTONE_PROVIDER_BUDGET_MAX_MS, Math.max(250, parsed));
}

/**
 * Private decision-local carrier. Symbols survive the object spreads used by
 * Keystone's message/deal side-slot decorators, but never leak through JSON by
 * accident. decisionToResponse is the sole point that turns it into the
 * bounded Coworld wire envelope.
 */
const KEYSTONE_PROVIDER_EVIDENCE = Symbol("keystoneProviderEvidence");
type KeystoneDecisionWithProviderEvidence = AgentDecision & {
  [KEYSTONE_PROVIDER_EVIDENCE]?: Record<string, unknown>;
};

/**
 * Attach only a strict aggregate. A malformed internally supplied shape is
 * carried as one tiny invalid sentinel so the game records
 * `providerEvidenceInvalid`; it is never repaired into fabricated valid call
 * evidence and never allowed to put arbitrary data on the wire.
 */
export function withKeystoneProviderEvidence(
  decision: AgentDecision,
  evidence: unknown,
): AgentDecision {
  const normalized = normalizeProviderEvidence(evidence);
  return {
    ...decision,
    [KEYSTONE_PROVIDER_EVIDENCE]:
      normalized ?? ({ invalid: true } satisfies Record<string, unknown>),
  } as KeystoneDecisionWithProviderEvidence;
}

function providerEvidenceForDecision(
  decision: AgentDecision,
): Record<string, unknown> | undefined {
  return (decision as KeystoneDecisionWithProviderEvidence)[
    KEYSTONE_PROVIDER_EVIDENCE
  ];
}

export function keystoneModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeystoneMode {
  const raw = env.PROXYWAR_KEYSTONE_MODE?.trim().toLowerCase() ?? "";
  if (raw === "mock" || raw === "claude-cli" || raw === "bedrock") {
    return raw;
  }
  if (raw !== "") {
    throw new Error(
      `Unknown PROXYWAR_KEYSTONE_MODE "${raw}" (expected mock|claude-cli|bedrock; ` +
        `there is no deterministic mode by design — the agent is the LLM brain)`,
    );
  }
  // Default = the LLM Commander. "The agent" IS the LLM brain (operator
  // standing rule, permanent) — there is no deterministic mode to fall back
  // to. Hosted --use-bedrock pods set USE_BEDROCK=true (inference on
  // Softmax's service account, payer confirmed 2026-06-10); everywhere else
  // the Claude CLI subscription is the default and fails loud if unavailable.
  return env.USE_BEDROCK === "true" ? "bedrock" : "claude-cli";
}

/**
 * Loads the repo agent modules from PROXYWAR_REPO at runtime. The adapter and
 * the repo live in different directories inside the pod (/app/integration vs
 * /app/proxywar), so these imports must stay dynamic; the type-only imports
 * above are erased by tsx and never resolve at runtime.
 */
export async function loadKeystoneModules(
  repoRoot: string,
): Promise<KeystoneModules> {
  const agentsDir = path.join(repoRoot, "src", "server", "agents");
  const plannerExecutor = (await import(
    pathToFileURL(path.join(agentsDir, "AgentPlannerExecutor.ts")).href
  )) as PlannerExecutorModule;
  const claudeCli = (await import(
    pathToFileURL(path.join(agentsDir, "ClaudeCliLlmProvider.ts")).href
  )) as ClaudeCliModule;
  return { plannerExecutor, claudeCli };
}

/**
 * Reconstructs the canonical AgentBrainInput from the wire payload the game
 * built with buildExternalAgentRequestPayload. The observation passes through
 * verbatim; legal actions arrive without their server-side intent (the runner
 * keeps intents — policies never see or emit raw intents), so intent is null
 * here and the brain selects purely by id/kind/risk/metadata.
 */
/**
 * Free-text comms for the house seat.
 *
 * Keystone's brain is the Commander/Executor, which chooses a GAME action and
 * emits no `messageActionID` at all (unlike `LlmAgentBrain`, whose bridge
 * landed with PR #130). So the champion seat was structurally mute: with the
 * league armed since 0.1.49, our own agent could not answer a single message.
 * The comms slot is separate from the action slot, so speaking never costs
 * keystone a turn of expansion or attack.
 *
 * Discipline is copied from the LLM starter rather than reinvented, because
 * that version is the one proven in hosted play — including the 3-reply
 * lifetime budget that ended the 861-reply echo storm of `ereq_3fc90743`.
 */
const KEYSTONE_MAX_REPLIES_PER_RIVAL = 3;

/**
 * At most one rival per decision, and only when there is something to answer
 * or a concrete border to settle. Silence is the default: an agent that talks
 * every step is noise, not negotiation.
 *
 * `answered` is MATCH-SCOPED (one Set per connection). Two key families share
 * it, exactly as the starter does, so no extra state is threaded through the
 * brain: the server-owned `messageEventID` prevents answering the same
 * message twice (with `<senderID>:<turnNumber>` only for legacy observations),
 * and `reply:<senderID>:<n>` counts the lifetime budget for that counterparty.
 */
export function chooseKeystoneMessageIntent(
  legalActions: LegalAction[],
  observation: AgentObservation,
  answered: Set<string>,
  maxChars = OPEN_ENDED_MESSAGE_MAX_CHARS,
): OpenEndedMessageIntent | null {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) return null;
  const offers = legalActions.filter((action) => action.kind === "message");
  if (offers.length === 0) return null;
  const recipientOf = (action: LegalAction): string | undefined => {
    const metadata = action.metadata as { recipientID?: unknown } | undefined;
    return typeof metadata?.recipientID === "string"
      ? metadata.recipientID
      : undefined;
  };
  const attributedInbound = (
    observation.nonCombat?.inboundMessages ?? []
  ).filter(
    (message) =>
      typeof message.senderID === "string" && message.senderID.length > 0,
  );
  const inbound = attributedInbound.filter((message) => {
    const key =
      typeof message.messageEventID === "string"
        ? message.messageEventID
        : `${message.senderID}:${message.turnNumber}`;
    return !answered.has(key);
  });

  if (attributedInbound.length > 0 && inbound.length === 0) return null;

  if (inbound.length > 0) {
    const newest = [...inbound].sort(
      (a, b) => Number(a.turnNumber ?? 0) - Number(b.turnNumber ?? 0),
    )[inbound.length - 1];
    const senderID = newest?.senderID;
    if (senderID) {
      const turnKey =
        typeof newest.messageEventID === "string"
          ? newest.messageEventID
          : `${senderID}:${newest.turnNumber}`;
      let repliesSpent = 0;
      while (
        repliesSpent < KEYSTONE_MAX_REPLIES_PER_RIVAL &&
        answered.has(`reply:${senderID}:${repliesSpent}`)
      ) {
        repliesSpent += 1;
      }
      const offer = offers.find((action) => recipientOf(action) === senderID);
      if (repliesSpent < KEYSTONE_MAX_REPLIES_PER_RIVAL && offer) {
        return {
          actionID: offer.id,
          recipientID: senderID,
          purpose: "reply",
          maxChars: Math.min(maxChars, OPEN_ENDED_MESSAGE_MAX_CHARS),
          ...(typeof newest.messageEventID === "string"
            ? { inboundMessageEventID: newest.messageEventID }
            : {}),
          commit: () => {
            answered.add(turnKey);
            answered.add(`reply:${senderID}:${repliesSpent}`);
          },
        };
      }
      // An unanswerable newest message (budget spent, or no offer for that
      // rival) means silence this decision — never fall through to an opener,
      // which would look like ignoring someone to talk past them.
      return null;
    }
  }

  // Opener: one per counterparty per match, and only to a bordering rival we
  // are not already allied with. Without this the house seat is purely
  // reactive, and a league where nobody speaks first has no conversation.
  for (const offer of offers) {
    const recipientID = recipientOf(offer);
    if (recipientID === undefined) continue;
    const key = `opener:${recipientID}`;
    if (answered.has(key)) continue;
    const rival = (observation.visiblePlayers ?? []).find(
      (player) => player.playerID === recipientID,
    );
    if (!rival?.sharesBorder || rival.isAllied) continue;
    return {
      actionID: offer.id,
      recipientID,
      purpose: "border_opener",
      maxChars: Math.min(maxChars, OPEN_ENDED_MESSAGE_MAX_CHARS),
      commit: () => answered.add(key),
    };
  }
  return null;
}

/**
 * Attaches a chosen message to the decision as the id/text PAIR the wire
 * contract requires. Never clobbers a brain that already spoke (no current
 * keystone brain does, but `LlmAgentBrain` would), and never invents a body
 * for an id or an id for a body.
 */
export function withKeystoneMessage(
  decision: AgentDecision,
  move: { actionID: string; text: string } | null,
): AgentDecision {
  if (move === null) return decision;
  if (typeof decision.messageActionID === "string") return decision;
  return {
    ...decision,
    messageActionID: move.actionID,
    messageText: move.text,
  };
}

/**
 * Structured deals for the house seat.
 *
 * Same shape of gap as the voice: the Commander/Executor emits no
 * `dealActionID`, so keystone never uses the dedicated DEAL SLOT, and the
 * league measured 18 of 27 policies never answering a proposal — those
 * policies absorbed 94.9% of every expired offer
 * (`2026-08-16-deal-non-response-diagnosis.md`).
 *
 * Deal/message actions are removed from the Commander/executor's PRIMARY menu
 * before it decides. The unfiltered offered menu remains available only to the
 * two dedicated social-slot choosers below. This separation matters: otherwise
 * the legacy planner can accept a support request as its primary while this
 * policy simultaneously rejects the same request in the deal slot, or consume
 * a message offer without the required body. Primary and side-slot selections
 * therefore cannot compete or contradict one another.
 *
 * The hard constraint shaping this policy: keystone's brain does not know
 * deals exist, so ACCEPTING an obligation it will not honor is worse than
 * silence — a proven violator poisons the trust evidence the whole social
 * layer is meant to produce. Two rules follow.
 *
 * 1. Accept only what we can honor. `non_aggression_pact`/`trade_security_pact`
 *    bind BOTH sides to abstain, so they are accepted only together with the
 *    compliance guard below, which removes attacks/embargoes against that
 *    partner from the menu before the brain ever sees them. `joint_attack`
 *    puts the obligation on the PROPOSER only (`buildDealObligations`), so
 *    accepting one costs us nothing. `support_request` demands donations from
 *    the main action slot, which belongs to the Commander — so it is rejected,
 *    explicitly.
 * 2. Answer everything, always. An explicit reject is honest and closes the
 *    loop; silent expiry is the defect measured across the league.
 *
 * We never withdraw our own unanswered offer — that was the deterministic
 * starters' defect (PR #113), where 96.4% of withdrawals landed one step after
 * the proposal and collapsed the recipient's answer window.
 */
const KEYSTONE_ABSTENTION_TEMPLATES = new Set([
  "non_aggression_pact",
  "trade_security_pact",
]);
const KEYSTONE_MAX_PROPOSALS_PER_RIVAL = 2;

type KeystoneDealDeps = {
  observation: AgentObservation;
  legalActions: LegalAction[];
  proposed: Set<string>;
};

const KEYSTONE_SIDE_SLOT_ACTION_KINDS = new Set<LegalAction["kind"]>([
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
  "message",
]);

/**
 * The legacy Commander/executor understands deal actions as diplomacy-shaped
 * primary candidates, but Keystone owns those actions through a sibling slot.
 * Keep the menus structurally separate so the primary is always an ordinary
 * game action and every deal/message id is handled only by its exact-id slot.
 *
 * Real gameplay menus always contain `hold`; returning an empty list here is
 * deliberate fail-closed behavior for a malformed protocol menu. The caller
 * then takes the loud transport fallback instead of re-exposing a side-slot id
 * to the primary planner.
 */
export function withoutKeystoneSideSlotActions(
  legalActions: LegalAction[],
): LegalAction[] {
  return legalActions.filter(
    (action) => !KEYSTONE_SIDE_SLOT_ACTION_KINDS.has(action.kind),
  );
}

function keystoneDealMetadata(action: LegalAction): {
  dealID?: string;
  recipientID?: string;
  template?: string;
} {
  const metadata = action.metadata as
    | { dealID?: unknown; recipientID?: unknown; template?: unknown }
    | undefined;
  return {
    dealID: typeof metadata?.dealID === "string" ? metadata.dealID : undefined,
    recipientID:
      typeof metadata?.recipientID === "string"
        ? metadata.recipientID
        : undefined,
    template:
      typeof metadata?.template === "string" ? metadata.template : undefined,
  };
}

/**
 * Partners we owe an abstention to right now: every active deal carrying a
 * pending `non_aggression`/`trade_security` obligation whose obligor is us.
 */
export function keystoneAbstentionPartners(observation: AgentObservation): {
  /** Partners protected from targeted aggression (both pact kinds). */
  partners: Set<string>;
  /** Partners protected from targeted manual embargoes. */
  tradeSecurityPartners: Set<string>;
} {
  const ownID = observation.ownState?.playerID;
  const partners = new Set<string>();
  const tradeSecurityPartners = new Set<string>();
  if (typeof ownID !== "string") return { partners, tradeSecurityPartners };
  for (const deal of observation.deals?.activeDeals ?? []) {
    for (const obligation of deal.obligations ?? []) {
      if (
        obligation.obligorPlayerID === ownID &&
        obligation.status === "pending" &&
        (obligation.kind === "non_aggression" ||
          obligation.kind === "trade_security")
      ) {
        const partnerID =
          deal.proposerPlayerID === ownID
            ? deal.recipientPlayerID
            : deal.proposerPlayerID;
        partners.add(partnerID);
        if (obligation.kind === "trade_security") {
          tradeSecurityPartners.add(partnerID);
        }
      }
    }
  }
  return { partners, tradeSecurityPartners };
}

/**
 * Compliance guard. Keystone's brain cannot see deals, so the only way an
 * accepted pact is actually honored is to remove the breaching actions BEFORE
 * the brain chooses.
 *
 * The withheld set MIRRORS THE REFEREE, rule for rule — see
 * `validatedHostileActionAgainst`/`validatedManualEmbargoAgainst` in
 * `src/server/agents/AgentDealCompliance.ts`. An earlier version filtered only
 * `attack` and `embargo`; review measured that against real
 * planner-executor artifacts and found the three missing shapes are 380 of 910
 * hostile actions (42%), with naval invasions OUTNUMBERING land attacks in a
 * league-representative episode (measured by the 2026-08-19 independent
 * review over planner-executor `decisions.jsonl` under `artifacts/`, incl.
 * `xpreq-coworld-2026-07-27T13-50-01-751Z-9d4448c8`; recorded in the
 * decision log). Keystone would have pacted exactly the
 * bordering seats it then boats and nukes, and each breach publishes a
 * `betrayal`-toned VERDICT into the public reliability aggregate. If a new
 * violation shape is ever added to the referee, it must be added here.
 *
 * Expansion carve-outs are copied deliberately: the referee does not count an
 * expansion attack or an expansion boat as a breach, so neither does the
 * guard — withholding them would cost the Commander moves it is entitled to.
 */
export function withoutKeystoneTreatyBreaches(
  legalActions: LegalAction[],
  observation: AgentObservation,
): LegalAction[] {
  const { partners, tradeSecurityPartners } =
    keystoneAbstentionPartners(observation);
  if (partners.size === 0) return legalActions;
  const kept = legalActions.filter((action) => {
    const metadata = action.metadata as
      | {
          targetID?: unknown;
          expansion?: unknown;
          navalInvasion?: unknown;
          action?: unknown;
        }
      | undefined;
    const targetID =
      typeof metadata?.targetID === "string" ? metadata.targetID : undefined;
    const aimedAtPartner = targetID !== undefined && partners.has(targetID);
    switch (action.kind) {
      case "attack":
        return !(aimedAtPartner && metadata?.expansion !== true);
      case "nuke":
        return !aimedAtPartner;
      case "boat":
        return !(
          aimedAtPartner &&
          metadata?.navalInvasion === true &&
          metadata?.expansion === false
        );
      case "embargo":
        // The referee judges a targeted embargo ONLY under a trade-security
        // obligation (`validatedManualEmbargoAgainst` is gated on it), so a
        // plain non-aggression pact must not cost the Commander this move.
        return !(
          targetID !== undefined &&
          tradeSecurityPartners.has(targetID) &&
          metadata?.action === "start"
        );
      case "embargo_all":
        // Target-independent: one pending trade-security pact bans it.
        return !(
          tradeSecurityPartners.size > 0 && metadata?.action === "start"
        );
      default:
        return true;
    }
  });
  // Never hand the brain an empty menu: a treaty is not worth a stalled seat.
  // Unreachable against a real menu — LegalActionBuilder always appends
  // `hold`, which is never filtered — so this cannot silently license a breach.
  return kept.length > 0 ? kept : legalActions;
}

/**
 * One deal action per decision, in the sibling slot to the game action. Answer
 * first (oldest deadline wins), propose only when there is nothing to answer.
 */
export function chooseKeystoneDealMove({
  observation,
  legalActions,
  proposed,
}: KeystoneDealDeps): LegalAction | null {
  if (!observation.deals) return null;

  const incoming = [...(observation.deals.incomingProposals ?? [])].sort(
    (a, b) =>
      (a.answerableThroughStep ?? 0) - (b.answerableThroughStep ?? 0) ||
      String(a.dealID).localeCompare(String(b.dealID)),
  );
  if (incoming.length > 0) {
    const proposal = incoming[0];
    const template = proposal.terms?.template;
    const proposerAlive = (observation.visiblePlayers ?? []).some(
      (player) =>
        player.playerID === proposal.proposerPlayerID && player.isAlive,
    );
    // `joint_attack` obligates the proposer only; abstention pacts we can hold
    // because the guard enforces them. Everything else gets an honest no.
    const accepts =
      proposerAlive &&
      (template === "joint_attack" ||
        (typeof template === "string" &&
          KEYSTONE_ABSTENTION_TEMPLATES.has(template)));
    const wanted = accepts ? "deal_accept" : "deal_reject";
    return (
      legalActions.find(
        (action) =>
          action.kind === wanted &&
          keystoneDealMetadata(action).dealID === proposal.dealID,
      ) ?? null
    );
  }

  // Propose a non-aggression pact to a bordering rival, at most twice per
  // counterparty per match, and never while one is already open with them.
  const openWith = new Set<string>();
  for (const view of [
    ...(observation.deals.outgoingProposals ?? []),
    ...(observation.deals.activeDeals ?? []),
  ]) {
    openWith.add(view.recipientPlayerID);
    openWith.add(view.proposerPlayerID);
  }
  for (const action of legalActions) {
    if (action.kind !== "deal_propose") continue;
    const { recipientID, template } = keystoneDealMetadata(action);
    if (recipientID === undefined || template !== "non_aggression_pact") {
      continue;
    }
    if (openWith.has(recipientID)) continue;
    const spent =
      Number(proposed.has(`${recipientID}:2`)) +
      Number(proposed.has(`${recipientID}:1`)) +
      Number(proposed.has(`${recipientID}:0`));
    if (spent >= KEYSTONE_MAX_PROPOSALS_PER_RIVAL) continue;
    const rival = (observation.visiblePlayers ?? []).find(
      (player) => player.playerID === recipientID,
    );
    if (!rival?.sharesBorder || rival.isAllied || rival.isAlive === false) {
      continue;
    }
    proposed.add(`${recipientID}:${spent}`);
    return action;
  }
  return null;
}

/** Attaches a chosen deal action to the decision's dedicated deal slot. */
export function withKeystoneDeal(
  decision: AgentDecision,
  move: LegalAction | null,
): AgentDecision {
  if (move === null) return decision;
  if (typeof decision.dealActionID === "string") return decision;
  return { ...decision, dealActionID: move.id };
}

/**
 * Reconstructs the canonical AgentBrainInput from the wire payload the game
 * built with buildExternalAgentRequestPayload. Raw server intents never cross
 * the policy boundary, but Commander compatibility predicates need the intent
 * facts already duplicated in server-owned action metadata. We reconstruct
 * only those bounded facts for in-process planning; the policy still returns
 * offered LegalAction IDs only, and the game remains the sole owner of
 * executable intents.
 */
export function requestToBrainInput(
  request: unknown,
  pinnedProfile?: AgentStrategyProfile,
): AgentBrainInput {
  const record = request as {
    observation?: AgentObservation;
    legalActions?: Array<{
      id?: unknown;
      kind?: unknown;
      label?: unknown;
      risk?: LegalAction["risk"];
      metadata?: LegalAction["metadata"];
    }>;
  };
  if (record === null || typeof record !== "object" || !record.observation) {
    throw new Error("decision_request payload is missing observation");
  }
  const rawActions = Array.isArray(record.legalActions)
    ? record.legalActions
    : [];
  if (rawActions.length === 0) {
    throw new Error("decision_request payload contained no legalActions");
  }
  const legalActions: LegalAction[] = rawActions.map((action) => {
    const kind = String(action.kind ?? "hold") as LegalAction["kind"];
    return {
      id: String(action.id ?? ""),
      kind,
      label: String(action.label ?? ""),
      intent: reconstructWireIntent(kind, action.metadata),
      risk: action.risk ?? { level: "medium", score: 0.5 },
      metadata: action.metadata,
    };
  });
  // Profile pin (v9 finding, 2026-07-12 A/B game2): the GAME side assigns a
  // strategy profile per seat slot, so the same keystone build played
  // "aggressive" in one slot and "diplomatic" in another — the Commander prompt
  // and module weights key off observation.profile, silently rotating the
  // agent's whole personality with its seat index. Keystone's stance is policy
  // config, not game state: pin it to OUR configured profile so behavior is
  // slot-invariant. Game state is untouched.
  const observation =
    pinnedProfile !== undefined && record.observation.profile !== pinnedProfile
      ? { ...record.observation, profile: pinnedProfile }
      : record.observation;
  return { observation, legalActions };
}

/**
 * Rebuilds only the non-secret compatibility projection already duplicated in
 * game-authored action metadata. This value is never sent back to the game;
 * execution remains bound to the original offered LegalAction.id there.
 */
export function reconstructWireIntent(
  kind: LegalAction["kind"],
  metadata: LegalAction["metadata"],
): LegalAction["intent"] {
  const value = metadata ?? {};
  const safeNonNegativeInteger = (candidate: unknown): candidate is number =>
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0;
  const safePositiveInteger = (candidate: unknown): candidate is number =>
    safeNonNegativeInteger(candidate) && candidate > 0;
  const boundedText = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 180;

  if (
    kind === "attack" &&
    (value.targetID === null || boundedText(value.targetID)) &&
    safePositiveInteger(value.troops)
  ) {
    return {
      type: "attack",
      targetID: value.targetID,
      troops: value.troops,
    };
  }
  if (
    kind === "boat" &&
    safeNonNegativeInteger(value.targetTile) &&
    safePositiveInteger(value.troops)
  ) {
    return { type: "boat", dst: value.targetTile, troops: value.troops };
  }
  if (kind === "build" && boundedText(value.unit)) {
    const tile = safeNonNegativeInteger(value.buildTile)
      ? value.buildTile
      : safeNonNegativeInteger(value.targetTile)
        ? value.targetTile
        : null;
    if (tile !== null) {
      return {
        type: "build_unit",
        unit: value.unit,
        tile,
      } as LegalAction["intent"];
    }
  }
  if (
    kind === "upgrade_structure" &&
    boundedText(value.unit) &&
    safeNonNegativeInteger(value.unitID)
  ) {
    return {
      type: "upgrade_structure",
      unit: value.unit,
      unitId: value.unitID,
    } as LegalAction["intent"];
  }
  if (
    kind === "embargo" &&
    boundedText(value.targetID) &&
    value.action === "start"
  ) {
    return { type: "embargo", targetID: value.targetID, action: "start" };
  }
  if (kind === "target_player" && boundedText(value.targetID)) {
    return { type: "targetPlayer", target: value.targetID };
  }
  if (kind === "retreat" && boundedText(value.attackID)) {
    return { type: "cancel_attack", attackID: value.attackID };
  }
  return null;
}

export function decisionToResponse(
  requestID: string,
  decision: AgentDecision,
  /**
   * What the game advertised on the decision_request envelope
   * (`protocol.maxActionsPerDecision`). Absent/<2 means an older game image
   * that carries only the scalar primary, so we must not emit the batch key.
   */
  wireMaxActionsPerDecision?: number,
  /** Independent spawn-ballot capability; never interpreted as batch width. */
  wireMaxSpawnPreferences?: number,
): Record<string, unknown> {
  const rawConfidence = decision.metadata?.confidence;
  const confidence =
    typeof rawConfidence === "number" &&
    rawConfidence >= 0 &&
    rawConfidence <= 1
      ? rawConfidence
      : 0.7;
  // Degradation flags travel on the wire so the game-side artifacts can
  // record them — a dead/degraded LLM brain must never look healthy in
  // replays (the hosted proxywar-bedrock seat failed silently for 60+ rounds
  // because the transport had no loudness channel).
  const llmPlannerDegraded = decision.metadata?.llmPlannerDegraded === true;
  // Validated through the SIBLING module, never `src/`. Every other `src/` import
  // in this file is `import type` and erases at build time; a value import would
  // resolve at runtime, and the deployed layout puts this file at
  // `/app/integration/src` with the repo at `/app/proxywar`, so `../../src/...`
  // points at nothing. The local mirror also happens to be exactly right here:
  // keystone is a PLAYER, so it may only emit the self-reported family.
  const degradedCause = llmPlannerDegraded
    ? normalizeDegradedCause(decision.metadata?.degradedCause)
    : undefined;
  const plannerFallbackUsed = decision.metadata?.plannerFallbackUsed === true;
  // The typed in-house brain already stamps the exact runtime path it used.
  // Forward only that bounded value; spawn/transport paths without a genuine
  // brain attribution remain unknown instead of inheriting the seat label.
  const runtimeMode = normalizeRuntimeMode(decision.metadata?.runtimeMode);
  const commanderExecution = commanderExecutionEnvelope(decision.metadata);
  const providerEvidence = providerEvidenceForDecision(decision);
  // The executor's cascade, normalized for the wire: primary first, deduped,
  // then capped to whatever the game advertised it will carry. Emitting more
  // than the advertisement would be silently truncated game-side, so the
  // remainder stays in the honest note instead.
  const cascade: string[] = [];
  for (const id of [
    decision.actionID,
    ...(Array.isArray(decision.actionIDs) ? decision.actionIDs : []),
  ]) {
    if (typeof id === "string" && id.length > 0 && !cascade.includes(id)) {
      cascade.push(id);
    }
  }
  const wireCapacity =
    typeof wireMaxActionsPerDecision === "number" &&
    Number.isFinite(wireMaxActionsPerDecision) &&
    wireMaxActionsPerDecision >= 2
      ? Math.floor(wireMaxActionsPerDecision)
      : 1;
  const carried = cascade.slice(0, Math.max(1, wireCapacity));
  const spawnCapacity =
    typeof wireMaxSpawnPreferences === "number" &&
    Number.isFinite(wireMaxSpawnPreferences) &&
    wireMaxSpawnPreferences >= 1
      ? Math.min(
          MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
          Math.floor(wireMaxSpawnPreferences),
        )
      : 0;
  const spawnPreferences =
    spawnCapacity > 0 && Array.isArray(decision.spawnPreferenceActionIDs)
      ? [
          decision.actionID,
          ...decision.spawnPreferenceActionIDs.filter(
            (id) => typeof id === "string" && id !== decision.actionID,
          ),
        ].slice(0, spawnCapacity)
      : undefined;
  // Truthful artifacts: whatever the wire cannot carry never executes, so it
  // must not read as "queued N action(s)" in decisions.jsonl. With no
  // advertisement this is the pre-batching behavior verbatim (primary only).
  const droppedBatchActions = Math.max(0, cascade.length - carried.length);
  const wireNote =
    droppedBatchActions > 0
      ? carried.length === 1
        ? ` [wire carries primary only; ${droppedBatchActions} batched follow-up(s) not executed]`
        : ` [wire carries ${carried.length} action(s); ${droppedBatchActions} batched follow-up(s) not executed]`
      : "";
  // Truncate the base reason, never the truth note. `decision.reason` is
  // `null` on a fallback/failure decision (no stated reason — see
  // `AgentDecision.reason`'s doc in src/server/agents/AgentTypes.ts); the
  // wire carries an honest empty base rather than fabricating text, while
  // `llmPlannerDegraded`/`fallbackUsed` below still flag the degradation.
  const wireReason =
    (decision.reason ?? "").slice(
      0,
      Math.max(0, RESPONSE_REASON_MAX_LENGTH - wireNote.length),
    ) + wireNote;
  return {
    type: "decision_response",
    requestID,
    selectedLegalActionId: decision.actionID,
    // Capability-gated: absent unless the game advertised a batch wire AND the
    // executor actually scheduled more than one action, so an old image (or an
    // ordinary single-action decision) sees a byte-identical response.
    ...(carried.length >= 2 ? { selectedLegalActionIds: carried } : {}),
    ...(spawnPreferences !== undefined
      ? { spawnPreferenceLegalActionIds: spawnPreferences }
      : {}),
    reason: wireReason,
    confidence,
    ...(runtimeMode !== undefined ? { runtimeMode } : {}),
    ...(commanderExecution !== undefined ? { commanderExecution } : {}),
    ...(providerEvidence !== undefined ? { providerEvidence } : {}),
    ...(llmPlannerDegraded ? { llmPlannerDegraded: true } : {}),
    ...(plannerFallbackUsed ? { fallbackUsed: true } : {}),
    // The cause has to be forwarded EXPLICITLY: this function picks fields rather
    // than spreading metadata, so a cause stamped upstream (transportFallbackResponse,
    // the executor) reaches no artifact unless it is named here. Validated through
    // the player-side parser, which means keystone - itself a player - cannot emit
    // the server-observed `brain-*` family even by mistake.
    ...(degradedCause !== undefined ? { degradedCause } : {}),
    // Comms slot, forwarded as a PAIR or not at all — the id must never reach
    // the validator without the body it is judged with. Named explicitly for
    // the same reason `degradedCause` is: this function PICKS fields, so a
    // decision that speaks reaches no artifact unless the pair is listed here.
    // That omission is exactly how the Coworld wire dropped every hosted
    // message before PR #125.
    ...(typeof decision.messageActionID === "string" &&
    decision.messageActionID.length > 0 &&
    typeof decision.messageText === "string"
      ? {
          selectedMessageActionId: decision.messageActionID,
          messageText: decision.messageText,
        }
      : {}),
    // Deal slot — same explicit-forwarding rule as the comms pair above.
    ...(typeof decision.dealActionID === "string" &&
    decision.dealActionID.length > 0
      ? { selectedDealActionId: decision.dealActionID }
      : {}),
  };
}

/**
 * Last-resort transport fallback. When the brain (or payload reconstruction)
 * throws, the match must not stall — but the resulting decision is DEGRADED and
 * MUST be loud. This routes through decisionToResponse with a synthesized
 * degraded AgentDecision so the wire carries fallbackUsed + llmPlannerDegraded
 * (matching llm-player.mjs). A dead/degraded brain must never look healthy in
 * replays — the v1 bedrock seat played 60+ hosted rounds on a silent fallback
 * because this branch had no loudness channel. Prefers an offered hold action
 * (lowest-risk no-op) over blindly taking legalActions[0].
 */
/**
 * Reads the batch capability the game advertised on the decision_request
 * envelope: `{ type, requestID, slot, protocol: { maxActionsPerDecision },
 * request }`. Undefined for an older image that never sends `protocol` — the
 * caller then emits the scalar primary only.
 */
export function wireMaxActionsPerDecision(
  message: Record<string, unknown>,
): number | undefined {
  const protocol = message.protocol;
  if (protocol === null || typeof protocol !== "object") {
    return undefined;
  }
  const advertised = (protocol as { maxActionsPerDecision?: unknown })
    .maxActionsPerDecision;
  return typeof advertised === "number" && Number.isFinite(advertised)
    ? advertised
    : undefined;
}

export function wireMaxSpawnPreferences(
  message: Record<string, unknown>,
): number | undefined {
  const protocol = message.protocol;
  if (protocol === null || typeof protocol !== "object") {
    return undefined;
  }
  const advertised = (protocol as { maxSpawnPreferences?: unknown })
    .maxSpawnPreferences;
  return typeof advertised === "number" && Number.isFinite(advertised)
    ? advertised
    : undefined;
}

export function spawnPreferenceDecision(
  input: AgentBrainInput,
  maxSpawnPreferences: number | undefined,
): AgentDecision | null {
  if (
    input.legalActions.length === 0 ||
    input.legalActions.some((action) => action.kind !== "spawn") ||
    typeof maxSpawnPreferences !== "number" ||
    !Number.isFinite(maxSpawnPreferences) ||
    maxSpawnPreferences < 1
  ) {
    return null;
  }
  const limit = Math.min(
    MAX_WIRE_SPAWN_PREFERENCE_ACTION_IDS,
    Math.floor(maxSpawnPreferences),
  );
  const ranked = input.legalActions
    .map((action, index) => ({
      action,
      index,
      score: spawnPreferenceScore(action),
      tile:
        typeof action.metadata?.tile === "number" &&
        Number.isFinite(action.metadata.tile)
          ? action.metadata.tile
          : Number.POSITIVE_INFINITY,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.tile - right.tile ||
        left.action.id.localeCompare(right.action.id) ||
        left.index - right.index,
    )
    .slice(0, limit)
    .map(({ action }) => action.id);
  return {
    actionID: ranked[0],
    spawnPreferenceActionIDs: ranked,
    reason: `Keystone ranked ${ranked.length} offered spawn actions from metadata.`,
    metadata: {
      brain: "keystone-spawn-preference",
      externalActionCall: false,
      fallbackUsed: false,
    },
  };
}

function spawnPreferenceScore(action: LegalAction): number {
  const score = (key: string): number => {
    const value = action.metadata?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const opportunity = score("opportunityScore");
  const pressure = score("pressureScore");
  const safety = score("safetyScore");
  const diplomacy = score("diplomacyScore");
  const localLand = score("localLandScore");
  const middleSafetyBand = Math.max(0, 1 - Math.abs(safety - 0.32) / 0.24);
  const lowSafetyPenalty =
    safety < 0.18
      ? (0.18 - safety) * 2.4 + 0.16
      : safety < 0.23
        ? (0.23 - safety) * 1.1
        : 0;
  return (
    opportunity * 0.32 +
    pressure * 0.18 +
    middleSafetyBand * 0.03 +
    localLand * 0.5 +
    safety * 0.25 +
    diplomacy * 0.28 -
    lowSafetyPenalty
  );
}

export function transportFallbackResponse(
  requestID: string,
  request: unknown,
  errorMessage: string,
  providerEvidence?: unknown,
): Record<string, unknown> {
  const actions =
    (request as { legalActions?: Array<{ id?: unknown; kind?: unknown }> })
      ?.legalActions ?? [];
  const holdAction = actions.find((action) => action.kind === "hold");
  // Fail closed after the primary-menu filter: if a malformed request offers
  // only deal/message side-slot ids, never resurrect one as the executable
  // scalar. Empty is intentionally rejected by the game-side validator.
  const fallbackActionID = String(holdAction?.id ?? "");
  const decision: AgentDecision = {
    actionID: fallbackActionID,
    reason: `keystone transport fallback: ${errorMessage}`,
    metadata: {
      confidence: 0.3,
      fallbackUsed: true,
      plannerFallbackUsed: true,
      llmPlannerDegraded: true,
      // Bounded cause. NOT a planner state: this catch covers request
      // reconstruction, spawn handling and executor exceptions, so it establishes
      // only that our own side threw. Claiming `plan-unavailable` here would
      // invent a planner diagnosis the code path does not support.
      degradedCause: "policy-error",
    },
  };
  return decisionToResponse(
    requestID,
    providerEvidence === undefined
      ? decision
      : withKeystoneProviderEvidence(decision, providerEvidence),
  );
}

/**
 * In-clock Commander adapter. plan() never awaits the wrapped LLM planner:
 * it returns the freshest completed background refresh if one landed,
 * otherwise carries the current directive (or a rule bootstrap plan before the
 * first refresh lands) and kicks the real refresh off in the background.
 * LLM failures surface loudly via llmPlannerDegraded on the next plan() —
 * never a silent degrade.
 */
export class DeferredAgentPlanner implements AgentPlanner {
  readonly plannerType: StrategicPlan["plannerSource"];
  private inFlight = false;
  private completed: AgentPlanDecision | null = null;
  private lastKnownPlan: StrategicPlan | null = null;
  // Set when a background Commander refresh failed but there was no plan to attach
  // the degraded flags to (no standing directive AND the bootstrap also failed).
  // The next plan() surfaces it so the degradation is never silent.
  private pendingDegradation: string | null = null;

  constructor(
    private readonly inner: AgentPlanner,
    private readonly bootstrap: AgentPlanner,
  ) {
    this.plannerType = inner.plannerType;
  }

  async plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision> {
    if (this.completed !== null) {
      const landed = this.completed;
      this.completed = null;
      this.lastKnownPlan = landed.plan;
      // Arm the NEXT refresh against the current observation before returning.
      // Without this, refreshes only ever started on calls that arrived
      // empty-handed, which silently halved the Commander cadence to
      // 2x planEvery and executed every landed plan one interval stale.
      this.startBackgroundRefresh(input, landed.plan);
      return landed;
    }
    // Surface (once) any degradation from a prior refresh failure that had no
    // plan to carry it.
    const degraded = this.pendingDegradation;
    this.pendingDegradation = null;
    const carriedPlan = previousPlan ?? this.lastKnownPlan;
    this.startBackgroundRefresh(input, carriedPlan);
    if (carriedPlan !== null) {
      return {
        plan: carriedPlan,
        reason:
          degraded !== null
            ? `Commander refresh failed (${degraded}); executing the standing directive degraded.`
            : "Commander refresh in flight; executing the standing directive in-clock.",
        latencyMs: 0,
        fallbackUsed: degraded !== null,
        ...(degraded !== null
          ? // A standing directive exists and the refresh failed: acting on stale
            // intent, which is a materially better state than having none.
            { llmPlannerDegraded: true, degradedCause: "plan-stale" as const }
          : {}),
      };
    }
    const bootstrapDecision = await this.bootstrap.plan(input, previousPlan);
    this.lastKnownPlan = bootstrapDecision.plan;
    return {
      ...bootstrapDecision,
      reason:
        degraded !== null
          ? `Bootstrap plan after a Commander refresh failed (${degraded}); running degraded.`
          : `Bootstrap plan while the first Commander refresh is in flight: ${bootstrapDecision.reason}`,
      fallbackUsed: degraded !== null ? true : bootstrapDecision.fallbackUsed,
      ...(degraded !== null
        ? // No standing directive AND the refresh failed - the dead-planner shape.
          {
            llmPlannerDegraded: true,
            degradedCause: "plan-unavailable" as const,
          }
        : {}),
    };
  }

  private startBackgroundRefresh(
    input: AgentBrainInput,
    carriedPlan: StrategicPlan | null,
  ): void {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    void this.inner
      .plan(input, carriedPlan)
      .then((decision) => {
        this.completed = decision;
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`keystone Commander refresh failed: ${message}`);
        const fallback =
          carriedPlan !== null
            ? null
            : await this.bootstrap.plan(input, null).catch(() => null);
        const plan = carriedPlan ?? fallback?.plan ?? null;
        if (plan !== null) {
          this.completed = {
            // Mark the plan itself as degraded-origin: the executor then flags
            // EVERY decision run under it (not just this refresh) until a
            // healthy Commander refresh replaces it.
            // The cause rides ON THE PLAN so every decision that inherits this
            // standing directive reports it, not only the refresh that failed.
            plan: {
              ...plan,
              degradedOrigin: true,
              degradedOriginCause: "plan-stale",
            },
            reason: `Commander refresh failed (${message}); continuing on the standing directive.`,
            latencyMs: 0,
            fallbackUsed: true,
            llmPlannerDegraded: true,
            // Same state as above, reached from the background refresh: a plan
            // exists, the refresh that would have replaced it failed.
            degradedCause: "plan-stale",
          };
        } else {
          // No standing directive and the bootstrap also failed: we cannot
          // fabricate a plan, but the degradation must not be silent — flag it so
          // the next plan() (which re-attempts the bootstrap) surfaces it.
          this.pendingDegradation = message;
        }
      })
      .finally(() => {
        this.inFlight = false;
      });
  }
}

/**
 * Bedrock model-id candidates, tried in order until one answers. The original
 * single pin (anthropic.claude-3-5-sonnet-20240620-v1:0) reached end-of-life
 * on Bedrock and the hosted seat silently failed every call for 60+ rounds —
 * autodetect makes a retired/disabled id self-healing instead of fatal.
 * PROXYWAR_LLM_MODEL_ID (when set) is always tried first.
 *
 * PROXYWAR_LLM_MODEL_STRICT=1 (with a pinned id) disables the fall-through:
 * the pinned model is the ONLY candidate, so an unavailable id degrades the
 * seat loudly (llmPlannerDegraded on the wire) instead of silently playing a
 * different model. Required for model-labeled seats — a seat advertised as
 * model X must never quietly answer as model Y.
 */
export function bedrockModelCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.PROXYWAR_LLM_MODEL_ID && env.PROXYWAR_LLM_MODEL_STRICT === "1") {
    return [env.PROXYWAR_LLM_MODEL_ID];
  }
  return [
    ...(env.PROXYWAR_LLM_MODEL_ID ? [env.PROXYWAR_LLM_MODEL_ID] : []),
    // Confirmed enabled on the Softmax Bedrock account 2026-06-23 (us-east-1, us-west-2,
    // us-east-2). Haiku MUST be the full date-suffixed inference-profile id — the bare
    // "us.anthropic.claude-haiku-4-5" is not a valid inference-profile id and fails
    // validation; sonnet-4-5 is the bare model id (us-west-2), not a us.-prefixed profile.
    "us.anthropic.claude-sonnet-4-6",
    "global.anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
  ];
}

/**
 * True when the error means "this model id is unusable on this account" —
 * retired, unknown, disabled, or needs an inference profile. Anything else
 * (auth, throttle, timeout) is NOT a reason to switch models.
 */
export function isModelUnavailableError(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("end of its life") ||
    text.includes("model identifier is invalid") ||
    text.includes("provided model identifier") ||
    text.includes("on-demand throughput") ||
    text.includes("not found") ||
    text.includes("not_found") ||
    text.includes("access to the model") ||
    text.includes("not authorized to invoke this model") ||
    text.includes("model is not supported") ||
    text.includes("use case details")
  );
}

export type BedrockResponseLike = {
  content?: Array<{ text?: unknown }>;
  model?: unknown;
  id?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
};

export type BedrockClientLike = {
  messages: {
    create: (
      body: Record<string, unknown>,
      options: { timeout: number; signal?: AbortSignal },
    ) => Promise<BedrockResponseLike>;
  };
};

interface BedrockClientOptions {
  awsRegion: string;
  baseURL?: string;
}

type KeystoneProviderAttemptStatus =
  | "pending"
  | "completed"
  | "failed"
  | "timed-out";

interface KeystoneProviderAttempt {
  model: string;
  status: KeystoneProviderAttemptStatus;
  responseModel?: string;
  requestID?: string;
  inputTokens?: number;
  outputTokens?: number;
  rawOutputPresent: boolean;
}

interface KeystoneProviderEvidenceState {
  provider: string;
  deadlineAt: number;
  attempts: KeystoneProviderAttempt[];
}

export interface KeystoneProviderEvidenceRecorder {
  beginDecision(): void;
  remainingBudgetMs(): number;
  startAttempt(model: string): number;
  completeAttempt(attempt: number, response: BedrockResponseLike): void;
  failAttempt(attempt: number, timedOut: boolean): void;
  takeEvidence(): CoworldProviderEvidence | undefined;
}

function boundedProviderEvidenceLabel(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
    ? value
    : undefined;
}

function boundedProviderTokenCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000_000
    ? value
    : undefined;
}

function bedrockResponseText(response: BedrockResponseLike): string {
  return (response.content ?? [])
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

/**
 * One decision-scoped terminal aggregate. There is deliberately no global
 * counter: a call can only be attributed to the exact response whose refresh
 * awaited it. Every started attempt receives exactly one terminal status.
 */
export function createKeystoneProviderEvidenceRecorder(options: {
  provider: string;
  budgetMs?: number;
  now?: () => number;
}): KeystoneProviderEvidenceRecorder {
  const provider = boundedProviderEvidenceLabel(options.provider, 64);
  if (provider === undefined) {
    throw new Error("invalid Keystone provider attribution");
  }
  const budgetMs = boundedKeystoneProviderBudgetMs(options.budgetMs);
  const now = options.now ?? Date.now;
  let state: KeystoneProviderEvidenceState | null = null;

  const requireState = (): KeystoneProviderEvidenceState => {
    state ??= { provider, deadlineAt: now() + budgetMs, attempts: [] };
    return state;
  };

  return {
    beginDecision() {
      if (state?.attempts.some((attempt) => attempt.status === "pending")) {
        throw new Error(
          "cannot start a Keystone provider group while an attempt is pending",
        );
      }
      state = { provider, deadlineAt: now() + budgetMs, attempts: [] };
    },

    remainingBudgetMs() {
      return Math.max(0, requireState().deadlineAt - now());
    },

    startAttempt(model: string) {
      const active = requireState();
      const boundedModel = boundedProviderEvidenceLabel(model, 160);
      if (boundedModel === undefined) {
        // Fail before invocation. An unattributable call is worse than a loud
        // no-call fallback because it cannot support honest model/cost proof.
        throw new Error("invalid Keystone Bedrock model attribution");
      }
      if (active.attempts.length >= 8) {
        throw new Error(
          "Keystone provider attempt cap reached before invocation",
        );
      }
      if (active.deadlineAt - now() <= 0) {
        throw new Error("Keystone provider aggregate budget exhausted");
      }
      active.attempts.push({
        model: boundedModel,
        status: "pending",
        rawOutputPresent: false,
      });
      return active.attempts.length - 1;
    },

    completeAttempt(attemptIndex, response) {
      const attempt = requireState().attempts[attemptIndex];
      if (attempt === undefined || attempt.status !== "pending") {
        throw new Error("Keystone provider attempt completed out of sequence");
      }
      attempt.status = "completed";
      const responseModel = boundedProviderEvidenceLabel(response.model, 160);
      const requestID = boundedProviderEvidenceLabel(response.id, 160);
      const inputTokens = boundedProviderTokenCount(
        response.usage?.input_tokens ?? response.usage?.inputTokens,
      );
      const outputTokens = boundedProviderTokenCount(
        response.usage?.output_tokens ?? response.usage?.outputTokens,
      );
      if (responseModel !== undefined) attempt.responseModel = responseModel;
      if (requestID !== undefined) attempt.requestID = requestID;
      if (inputTokens !== undefined) attempt.inputTokens = inputTokens;
      if (outputTokens !== undefined) attempt.outputTokens = outputTokens;
      attempt.rawOutputPresent = bedrockResponseText(response).length > 0;
    },

    failAttempt(attemptIndex, timedOut) {
      const attempt = requireState().attempts[attemptIndex];
      if (attempt === undefined || attempt.status !== "pending") {
        throw new Error("Keystone provider attempt failed out of sequence");
      }
      attempt.status = timedOut ? "timed-out" : "failed";
    },

    takeEvidence() {
      const completedState = state;
      state = null;
      if (completedState === null || completedState.attempts.length === 0) {
        return undefined;
      }
      // A synchronous provider should never leave a pending promise behind.
      // If a future refactor does, close it as timed out so the aggregate stays
      // terminal and the defect cannot masquerade as a completed/clean call.
      for (const attempt of completedState.attempts) {
        if (attempt.status === "pending") attempt.status = "timed-out";
      }
      const completed = completedState.attempts.filter(
        (attempt) => attempt.status === "completed",
      );
      const failedAttemptCount = completedState.attempts.filter(
        (attempt) => attempt.status === "failed",
      ).length;
      const timedOutAttemptCount = completedState.attempts.filter(
        (attempt) => attempt.status === "timed-out",
      ).length;
      const inputTokenValues = completed
        .map((attempt) => attempt.inputTokens)
        .filter((value): value is number => value !== undefined);
      const outputTokenValues = completed
        .map((attempt) => attempt.outputTokens)
        .filter((value): value is number => value !== undefined);
      const inputTokens = inputTokenValues.reduce(
        (sum, value) => sum + value,
        0,
      );
      const outputTokens = outputTokenValues.reduce(
        (sum, value) => sum + value,
        0,
      );
      const soleCompleted = completed.length === 1 ? completed[0] : undefined;
      const evidence: CoworldProviderEvidence = {
        callKind: "planner",
        provider: completedState.provider,
        requestedModel: completedState.attempts[0].model,
        attemptedModels: completedState.attempts.map(
          (attempt) => attempt.model,
        ),
        attemptCount: completedState.attempts.length,
        completedAttemptCount: completed.length,
        failedAttemptCount,
        timedOutAttemptCount,
        // Response identity is only response-correlated when exactly one
        // provider response completed. Token totals are sums over completed
        // responses only and are omitted unless every completed response
        // reported that side of usage.
        ...(soleCompleted?.responseModel !== undefined
          ? { responseModel: soleCompleted.responseModel }
          : {}),
        ...(soleCompleted?.requestID !== undefined
          ? { requestID: soleCompleted.requestID }
          : {}),
        ...(completed.length > 0 &&
        inputTokenValues.length === completed.length &&
        inputTokens <= 1_000_000_000
          ? { inputTokens }
          : {}),
        ...(completed.length > 0 &&
        outputTokenValues.length === completed.length &&
        outputTokens <= 1_000_000_000
          ? { outputTokens }
          : {}),
        rawOutputPresent: completed.some((attempt) => attempt.rawOutputPresent),
      };
      // This assertion is the writer-side half of the wire contract. It must
      // never repair or coerce: a locally impossible aggregate is a code bug.
      if (normalizeProviderEvidence(evidence) === null) {
        throw new Error("Keystone produced malformed provider evidence");
      }
      return evidence;
    },
  };
}

export function isKeystoneProviderTimeoutError(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = String(value?.name ?? "").toLowerCase();
  const code = String(value?.code ?? "").toLowerCase();
  const message = String(value?.message ?? error ?? "").toLowerCase();
  return (
    name.includes("timeout") ||
    name === "aborterror" ||
    code === "etimedout" ||
    code === "aborted" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("aborted")
  );
}

/** Exact hosted-sidecar routing options, kept pure for release verification. */
export function keystoneBedrockSidecarEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Keystone Bedrock sidecar endpoint is invalid");
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.port === ""
  ) {
    throw new Error("Keystone Bedrock sidecar endpoint is invalid");
  }
  return endpoint.toString().replace(/\/$/, "");
}

/** Exact hosted-sidecar routing options, kept pure for release verification. */
export function keystoneBedrockClientOptions(
  region: string,
  env: NodeJS.ProcessEnv = process.env,
): BedrockClientOptions {
  const sidecarEndpoint = keystoneBedrockSidecarEndpoint(env);
  return {
    awsRegion: region,
    ...(sidecarEndpoint !== undefined && sidecarEndpoint.length > 0
      ? { baseURL: sidecarEndpoint }
      : {}),
  };
}

export interface KeystoneBedrockProviderHandle {
  provider: LlmProvider;
  evidence: KeystoneProviderEvidenceRecorder;
}

export function createKeystoneBedrockProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    createClient?: () => Promise<BedrockClientLike>;
    now?: () => number;
  } = {},
): KeystoneBedrockProviderHandle {
  const candidates = bedrockModelCandidates(env);
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2";
  const budgetMs = boundedKeystoneProviderBudgetMs(env.PROXYWAR_LLM_TIMEOUT_MS);
  const sidecarEndpoint = keystoneBedrockSidecarEndpoint(env);
  if (env.USE_BEDROCK === "true" && sidecarEndpoint === undefined) {
    throw new Error("Keystone Bedrock sidecar endpoint is missing");
  }
  const providerName =
    sidecarEndpoint === undefined ? "aws-bedrock" : "bedrock-sidecar";
  const evidence = createKeystoneProviderEvidenceRecorder({
    provider: providerName,
    budgetMs,
    now: deps.now,
  });
  let client: BedrockClientLike | null = null;
  let lockedIndex: number | null = null;
  const createClient =
    deps.createClient ??
    (async (): Promise<BedrockClientLike> => {
      // Resolved at pod runtime only (adapter dependency); kept opaque so
      // vite/vitest never try to bundle it.
      const bedrockSpecifier = "@anthropic-ai/bedrock-sdk";
      const mod = (await import(/* @vite-ignore */ bedrockSpecifier)) as {
        default?: new (options: BedrockClientOptions) => BedrockClientLike;
        AnthropicBedrock?: new (
          options: BedrockClientOptions,
        ) => BedrockClientLike;
      };
      const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock;
      if (AnthropicBedrock === undefined) {
        throw new Error("@anthropic-ai/bedrock-sdk did not export a client");
      }
      return new AnthropicBedrock(keystoneBedrockClientOptions(region, env));
    });
  const provider: LlmProvider = {
    providerType: "custom",
    model: candidates[0] ?? null,
    async complete(prompt: string): Promise<string> {
      // SIDECAR ENDPOINT (platform change 2026-07-30). Hosted pods do NOT
      // reach AWS directly: they get a per-pod proxy at
      // AWS_ENDPOINT_URL_BEDROCK_RUNTIME plus DELIBERATELY FAKE placeholder
      // credentials. Calling the real Bedrock host with those placeholders
      // returns `403 {"Message":"Invalid API Key format: Must start with
      // pre-defined prefix"}` and the seat silently degrades to the rule
      // planner — which is what the league has been ranking. Verified in-pod
      // 2026-08-19 via PROXYWAR_KEYSTONE_BEDROCK_DIAG=1. Absent variable
      // falls back to the SDK default, so local runs are unchanged.
      client ??= await createClient();
      const startIndex = lockedIndex ?? 0;
      let lastError: unknown = null;
      for (let i = startIndex; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const attempt = evidence.startAttempt(candidate);
        const remainingMs = evidence.remainingBudgetMs();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), remainingMs);
        try {
          const response = await client.messages.create(
            {
              model: candidate,
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
            },
            { timeout: remainingMs, signal: controller.signal },
          );
          evidence.completeAttempt(attempt, response);
          if (lockedIndex !== i) {
            lockedIndex = i;
            console.log(`keystone bedrock model locked: ${candidate}`);
          }
          return bedrockResponseText(response);
        } catch (error) {
          lastError = error;
          const timedOut =
            controller.signal.aborted || isKeystoneProviderTimeoutError(error);
          evidence.failAttempt(attempt, timedOut);
          const message = error instanceof Error ? error.message : error;
          if (!timedOut && isModelUnavailableError(message)) {
            console.error(
              `keystone bedrock model unavailable, trying next: ${candidate} -> ${String(message).slice(0, 160)}`,
            );
            continue;
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw new Error(
        `No Bedrock model candidate is usable on this account (tried ${candidates.join(", ")}): ${String(
          lastError instanceof Error ? lastError.message : lastError,
        ).slice(0, 200)}`,
      );
    },
  };
  return { provider, evidence };
}

class KeystoneProviderEvidenceAgentBrain implements AgentBrain {
  readonly brainType: AgentBrain["brainType"];

  constructor(
    private readonly inner: AgentBrain,
    private readonly evidence: KeystoneProviderEvidenceRecorder,
  ) {
    this.brainType = inner.brainType;
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    this.evidence.beginDecision();
    try {
      const decision = await this.inner.decide(input);
      const providerEvidence = this.evidence.takeEvidence();
      return providerEvidence === undefined
        ? decision
        : withKeystoneProviderEvidence(decision, providerEvidence);
    } catch (error) {
      throw new KeystoneProviderDecisionError(
        error instanceof Error ? error.message : String(error),
        this.evidence.takeEvidence(),
      );
    }
  }
}

class KeystoneProviderDecisionError extends Error {
  constructor(
    message: string,
    readonly providerEvidence: CoworldProviderEvidence | undefined,
  ) {
    super(message);
    this.name = "KeystoneProviderDecisionError";
  }
}

export function createKeystoneBrain(
  modules: KeystoneModules,
  options: KeystoneBrainOptions,
): AgentBrain {
  const {
    PlannerExecutorAgentBrain,
    RuleAgentPlanner,
    MockLlmPlanner,
    LlmAgentPlanner,
    FrontierPolicyExecutor,
  } = modules.plannerExecutor;
  const planEveryDecisionSteps = options.planEveryDecisionSteps ?? 3;
  const executor = new FrontierPolicyExecutor(options.profile, {
    settings: { ...KEYSTONE_EXECUTOR_SETTINGS },
  });

  let planner: AgentPlanner;
  let providerEvidence: KeystoneProviderEvidenceRecorder | null = null;
  if (options.mode === "mock") {
    planner = new MockLlmPlanner(options.profile);
  } else {
    let provider = options.provider;
    if (provider === undefined && options.mode === "bedrock") {
      const bedrock =
        options.bedrockProviderHandle ?? createKeystoneBedrockProvider();
      provider = bedrock.provider;
      providerEvidence = bedrock.evidence;
    }
    provider ??= modules.claudeCli.createClaudeCliLlmProviderFromEnv();
    const llmPlanner = new LlmAgentPlanner({
      provider,
      profile: options.profile,
      // The Bedrock provider owns the actual <=12s aggregate deadline and
      // abort. Keep the planner's generic timeout slightly outside it so it
      // cannot win the race and abandon a still-settling SDK promise.
      providerTimeoutMs:
        providerEvidence !== null
          ? KEYSTONE_PROVIDER_BUDGET_MAX_MS + 500
          : options.providerTimeoutMs,
      plannerType: "real-llm",
    });
    // Hosted Bedrock is synchronous ONLY on refresh decisions: this is the
    // correlation boundary for terminal provider evidence. The plan cadence
    // still makes intervening executor decisions immediate and no-call. Local
    // Claude CLI retains the background adapter unless explicitly diagnosed in
    // blocking mode.
    planner =
      options.mode === "bedrock" || options.blocking
        ? llmPlanner
        : new DeferredAgentPlanner(
            llmPlanner,
            new RuleAgentPlanner(options.profile),
          );
  }

  const brain = new PlannerExecutorAgentBrain({
    profile: options.profile,
    planner,
    executor,
    planEveryDecisionSteps,
  });
  return providerEvidence === null || options.deferProviderEvidence === true
    ? brain
    : new KeystoneProviderEvidenceAgentBrain(brain, providerEvidence);
}

function redactPlayerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "***");
    }
    return parsed.toString();
  } catch {
    return "<unparseable player url>";
  }
}

async function main(): Promise<void> {
  const url = process.env.COWORLD_PLAYER_WS_URL;
  if (!url) {
    throw new Error("COWORLD_PLAYER_WS_URL is required");
  }
  const repoRoot = process.env.PROXYWAR_REPO ?? "/app/proxywar";
  const mode = keystoneModeFromEnv();
  const configuredProfile = process.env.PROXYWAR_KEYSTONE_PROFILE?.trim();
  const profile = (
    configuredProfile === undefined || configuredProfile === ""
      ? "aggressive"
      : configuredProfile
  ) as AgentStrategyProfile;
  const blocking =
    process.env.PROXYWAR_KEYSTONE_BLOCKING === "1" ||
    process.env.PROXYWAR_KEYSTONE_BLOCKING?.trim().toLowerCase() === "true";
  const planEveryRaw = Number(process.env.PROXYWAR_KEYSTONE_PLAN_EVERY ?? "3");
  // Blocking pure-Commander runs the LLM EVERY decision (planEvery=1) so every
  // wire decision is bedrock-driven and the transport is fully exercised.
  const planEveryDecisionSteps = blocking
    ? 1
    : Number.isFinite(planEveryRaw) && planEveryRaw >= 1
      ? Math.floor(planEveryRaw)
      : 3;

  const modules = await loadKeystoneModules(repoRoot);
  const bedrockProviderHandle =
    mode === "bedrock" ? createKeystoneBedrockProvider() : undefined;
  const sharedProvider =
    bedrockProviderHandle?.provider ??
    (mode === "claude-cli"
      ? modules.claudeCli.createClaudeCliLlmProviderFromEnv()
      : undefined);
  const brain = createKeystoneBrain(modules, {
    mode,
    profile,
    planEveryDecisionSteps,
    blocking,
    ...(bedrockProviderHandle === undefined
      ? sharedProvider === undefined
        ? {}
        : { provider: sharedProvider }
      : { bedrockProviderHandle, deferProviderEvidence: true }),
  });

  // Optional configuration diagnostic (gated; OFF in production). It no longer
  // invokes Bedrock at startup: every actual model call must belong to exactly
  // one decision-scoped terminal providerEvidence aggregate.
  let bedrockDiag = "";
  if (process.env.PROXYWAR_KEYSTONE_BEDROCK_DIAG === "1") {
    const resolvedRegion =
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
    const keyState = process.env.AWS_ACCESS_KEY_ID ? "set" : "MISSING";
    const tokenState = process.env.AWS_SESSION_TOKEN ? "set" : "absent";
    const probe = "disabled:decision-correlated-provider-evidence";
    bedrockDiag = `BEDROCKDIAG[USE_BEDROCK=${process.env.USE_BEDROCK ?? "unset"} key=${keyState} token=${tokenState} AWS_REGION=${process.env.AWS_REGION ?? "unset"} resolved=${resolvedRegion} probe=${probe}]`;
    console.log(bedrockDiag);
  }

  const require = createRequire(import.meta.url);
  const { WebSocket } = require(`${repoRoot}/node_modules/ws`);
  const socket = new WebSocket(url);

  socket.on("open", () => {
    console.log(
      `keystone connected ${redactPlayerUrl(url)} (mode=${mode}, profile=${profile}, planEvery=${planEveryDecisionSteps}, blocking=${blocking}, ${keystoneTunableFlagSummary()})`,
    );
  });

  // Serialize decision handling: a platform retry that overlaps an in-flight
  // request must not interleave brain.decide() on shared mutable state
  // (decisionsSincePlan, opponent-ledger rising-edge counters).
  let decisionChain: Promise<void> = Promise.resolve();
  let sawFinal = false;
  // Match-scoped comms memory: answered turns + per-rival lifetime reply
  // budget. One Set per connection, so it dies with the episode.
  const answeredMessages = new Set<string>();
  // Match-scoped proposal budget, keyed `<recipientID>:<n>`.
  const proposedDeals = new Set<string>();
  socket.on("message", (data: unknown) => {
    let message: {
      type?: unknown;
      requestID?: unknown;
      request?: unknown;
      protocol?: { maxMessageChars?: unknown };
    };
    try {
      message = JSON.parse(String(data));
    } catch (error) {
      // A malformed frame silently dropped looks like a seat timeout
      // platform-side — log it so the failure is attributable from pod logs.
      console.error(
        `keystone: dropping unparseable frame (${error instanceof Error ? error.message : String(error)})`,
      );
      return;
    }
    if (message.type === "final") {
      sawFinal = true;
      console.log("episode final; exiting");
      socket.close();
      return;
    }
    if (message.type !== "decision_request") {
      return;
    }
    decisionChain = decisionChain.then(async () => {
      const requestID = String(message.requestID ?? "");
      const startedAt = Date.now();
      let response: Record<string, unknown>;
      try {
        const input = requestToBrainInput(message.request, profile);
        // The sealed spawn ballot is local and deterministic. Bypassing the
        // Commander/executor prevents a pre-game preference request from
        // consuming planning cadence or ordinary action history.
        const spawnDecision = spawnPreferenceDecision(
          input,
          wireMaxSpawnPreferences(message),
        );
        // Spawn ballots carry an all-spawn menu with no comms offers, and the
        // game suppresses the comms slot there anyway — so only an ordinary
        // decision is given a voice.
        let decision: AgentDecision;
        if (spawnDecision !== null) {
          decision = spawnDecision;
        } else {
          // Honor first, then decide: treaty-breaking actions are withheld
          // from the brain, so an accepted pact cannot be violated by a
          // Commander that does not know it exists.
          let compliantActions = input.legalActions;
          try {
            compliantActions = withoutKeystoneTreatyBreaches(
              input.legalActions,
              input.observation,
            );
          } catch (guardError) {
            // Fail OPEN on the menu (the brain still plays) but say so: a
            // silent unfiltered menu is how a pact gets broken unnoticed.
            console.error(
              `keystone treaty guard skipped, menu unfiltered: ${guardError instanceof Error ? guardError.message : String(guardError)}`,
            );
          }
          const primaryActions =
            withoutKeystoneSideSlotActions(compliantActions);
          if (primaryActions.length === 0) {
            throw new Error(
              "keystone primary menu has no ordinary action after removing social side slots",
            );
          }
          const compliantInput: AgentBrainInput = {
            ...input,
            legalActions: primaryActions,
          };
          const maxMessageChars =
            typeof message.protocol?.maxMessageChars === "number" &&
            Number.isSafeInteger(message.protocol.maxMessageChars) &&
            message.protocol.maxMessageChars > 0
              ? Math.min(
                  message.protocol.maxMessageChars,
                  OPEN_ENDED_MESSAGE_MAX_CHARS,
                )
              : 0;
          const messageIntent = chooseKeystoneMessageIntent(
            input.legalActions,
            input.observation,
            answeredMessages,
            maxMessageChars,
          );
          bedrockProviderHandle?.evidence.beginDecision();
          const primaryPromise = Promise.resolve(brain.decide(compliantInput));
          const socialPromise =
            messageIntent !== null && sharedProvider !== undefined
              ? generateOpenEndedMessage({
                  provider: sharedProvider,
                  agentName: "Auri",
                  personality:
                    "Concise, hard-nosed, strategically credible, and willing to cooperate when interests align. Negotiate concrete borders, timing, threats, and reciprocal commitments; do not flatter or make promises you cannot keep.",
                  intent: messageIntent,
                  observation: input.observation,
                  decision: {
                    actionID: compliantActions[0].id,
                    reason:
                      "Primary Commander decision is being selected concurrently.",
                  },
                }).catch((error) => {
                  console.error(
                    `keystone social generation skipped: ${error instanceof Error ? error.message : String(error)}`,
                  );
                  return null;
                })
              : Promise.resolve(null);
          const [primaryResult, generatedMessage] = await Promise.all([
            primaryPromise.then(
              (value) => ({ ok: true as const, value }),
              (error) => ({ ok: false as const, error }),
            ),
            socialPromise,
          ]);
          if (generatedMessage !== null) messageIntent?.commit?.();
          const providerEvidence =
            bedrockProviderHandle?.evidence.takeEvidence();
          if (!primaryResult.ok) {
            throw new KeystoneProviderDecisionError(
              primaryResult.error instanceof Error
                ? primaryResult.error.message
                : String(primaryResult.error),
              providerEvidence,
            );
          }
          const decided =
            providerEvidence === undefined
              ? primaryResult.value
              : withKeystoneProviderEvidence(
                  primaryResult.value,
                  providerEvidence,
                );
          // The social slots are cosmetic relative to the game action: a bug
          // in either chooser must never discard an already-valid decision and
          // stamp it degraded, which would pollute the very degradation
          // telemetry this project tracks.
          let socialDecision = decided;
          try {
            socialDecision = withKeystoneDeal(
              withKeystoneMessage(decided, generatedMessage),
              chooseKeystoneDealMove({
                observation: input.observation,
                legalActions: input.legalActions,
                proposed: proposedDeals,
              }),
            );
          } catch (socialError) {
            console.error(
              `keystone social slots skipped: ${socialError instanceof Error ? socialError.message : String(socialError)}`,
            );
          }
          decision = socialDecision;
        }
        response = decisionToResponse(
          requestID,
          decision,
          wireMaxActionsPerDecision(message),
          wireMaxSpawnPreferences(message),
        );
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : String(error);
        console.error(`keystone decide failed: ${messageText}`);
        // Last-resort: degraded but LOUD — fallbackUsed + llmPlannerDegraded
        // travel on the wire so the game-side artifacts never report a dead
        // brain as healthy. See transportFallbackResponse.
        response = transportFallbackResponse(
          requestID,
          message.request,
          messageText,
          error instanceof KeystoneProviderDecisionError
            ? error.providerEvidence
            : undefined,
        );
      }
      if (bedrockDiag) {
        response.reason = `${bedrockDiag} || ${String(response.reason ?? "")}`;
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 5000) {
        console.warn(
          `keystone decision took ${elapsedMs}ms — investigate before the clock bites`,
        );
      }
      socket.send(JSON.stringify(response));
    });
  });

  socket.on("close", () => {
    // A transport death mid-episode must not masquerade as a clean exit —
    // the platform (and our artifacts) should see the seat die loudly.
    if (!sawFinal) {
      console.error("keystone: websocket closed before the final message");
      process.exit(1);
    }
    process.exit(0);
  });

  socket.on("error", (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

const isMain = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
