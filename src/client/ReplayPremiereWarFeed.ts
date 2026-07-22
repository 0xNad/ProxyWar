import {
  GameUpdateType,
  type AllianceRequestReplyUpdate,
  type BrokeAllianceUpdate,
  type ConquestUpdate,
  type DisplayChatMessageUpdate,
  type EmojiUpdate,
  type GameUpdateViewData,
  type PlayerUpdate,
  type UnitUpdate,
} from "../core/game/GameUpdates";

/**
 * Spoiler-safe live war narrative for sealed Replay Premieres.
 *
 * During pre-reveal playback every myPlayer-centric HUD surface (events
 * ticker, chat, attack list) renders nothing for a spectator, and the
 * artifact-backed league overlay cannot ship because its telemetry carries
 * outcomes. This module derives the WAR ITSELF — attacks between agents,
 * alliances forming and breaking, nukes flying, emotes and quick-chat — from
 * the simulation updates the premiere client is already rendering, so the
 * overlay can show the narrative as it happens.
 *
 * Spoiler safety by construction: every event is a fact of the moment the
 * viewer is already watching on the map (derived from the same update batch),
 * carries no totals, no final standings, no winner, and no stream-length
 * information. Win updates are deliberately never read here.
 */

export type PremiereWarEventKind =
  | "attack"
  | "alliance"
  | "betrayal"
  | "nuke"
  | "conquest"
  | "emote"
  | "chat";

export interface PremiereWarEvent {
  kind: PremiereWarEventKind;
  /** Spectator display name of the acting agent. */
  actor: string;
  /** Spectator display name of the target, when the event has one. */
  target: string | null;
  /**
   * Kind-specific payload: the emoji glyph for `emote`, the quick-chat
   * `{category}.{key}` suffix (translated by the overlay as `chat.{detail}`)
   * for `chat`, and null otherwise.
   */
  detail: string | null;
  /** Game turn the event was observed on (already visible to the viewer). */
  turn: number;
}

export interface PremiereWarNameResolver {
  /** Display name for an in-game small id, or null when unknown. */
  bySmallId(smallId: number): string | null;
  /** Display name for a PlayerID, or null when unknown. */
  byPlayerId(playerId: string): string | null;
}

/** Nuke-class unit type labels (mirrors UnitType values used by the core). */
const NUKE_UNIT_TYPES = new Set(["Atom Bomb", "Hydrogen Bomb", "MIRV"]);

/** At most this many events are surfaced per update batch. */
export const MAX_WAR_EVENTS_PER_BATCH = 12;
/** Dedupe memories are halved once they exceed this bound. */
const MAX_TRACKED_IDS = 2_048;

/**
 * Per-premiere dedupe state. Attack/nuke updates re-deliver the same entity
 * on later batches (state snapshots), so first-sighting sets keep the feed to
 * genuine new developments.
 */
export class PremiereWarFeedTracker {
  private readonly seenAttackIds = new Set<string>();
  private readonly seenNukeIds = new Set<number>();

  extract(
    update: GameUpdateViewData,
    turnNumber: number,
    resolver: PremiereWarNameResolver,
  ): PremiereWarEvent[] {
    const events: PremiereWarEvent[] = [];
    const push = (event: PremiereWarEvent | null) => {
      if (event !== null && events.length < MAX_WAR_EVENTS_PER_BATCH) {
        events.push(event);
      }
    };

    for (const raw of update.updates[GameUpdateType.BrokeAlliance] ?? []) {
      const broke = raw as BrokeAllianceUpdate;
      push(
        this.pair("betrayal", broke.traitorID, broke.betrayedID, resolver, {
          turn: turnNumber,
        }),
      );
    }
    for (const raw of update.updates[GameUpdateType.AllianceRequestReply] ??
      []) {
      const reply = raw as AllianceRequestReplyUpdate;
      if (!reply.accepted) continue;
      push(
        this.pair(
          "alliance",
          reply.request.requestorID,
          reply.request.recipientID,
          resolver,
          { turn: turnNumber },
        ),
      );
    }
    for (const raw of update.updates[GameUpdateType.ConquestEvent] ?? []) {
      const conquest = raw as ConquestUpdate;
      const actor = resolver.byPlayerId(conquest.conquerorId);
      const target = resolver.byPlayerId(conquest.conqueredId);
      if (actor === null || target === null) continue;
      push({ kind: "conquest", actor, target, detail: null, turn: turnNumber });
    }
    for (const raw of update.updates[GameUpdateType.Emoji] ?? []) {
      const emoji = (raw as EmojiUpdate).emoji;
      const actor = resolver.bySmallId(emoji.senderID);
      if (actor === null) continue;
      const target =
        typeof emoji.recipientID === "number"
          ? resolver.bySmallId(emoji.recipientID)
          : null;
      push({
        kind: "emote",
        actor,
        target,
        detail: emoji.message,
        turn: turnNumber,
      });
    }
    const chatSeenThisBatch = new Set<string>();
    for (const raw of update.updates[GameUpdateType.DisplayChatEvent] ?? []) {
      const chat = raw as DisplayChatMessageUpdate;
      // Quick chat fans one display event out per player; collapse to one
      // feed entry keyed on sender+phrase.
      const senderName = resolver.byPlayerId(chat.recipient);
      if (senderName === null) continue;
      const dedupeKey = `${chat.recipient}:${chat.category}:${chat.key}`;
      if (chatSeenThisBatch.has(dedupeKey)) continue;
      chatSeenThisBatch.add(dedupeKey);
      push({
        kind: "chat",
        actor: senderName,
        target:
          chat.target === undefined
            ? null
            : resolver.byPlayerId(chat.target),
        detail: `${chat.category}.${chat.key}`,
        turn: turnNumber,
      });
    }
    for (const raw of update.updates[GameUpdateType.Player] ?? []) {
      const player = raw as PlayerUpdate;
      for (const attack of player.outgoingAttacks ?? []) {
        if (attack.retreating || this.seenAttackIds.has(attack.id)) continue;
        this.rememberAttack(attack.id);
        // Only agent-vs-agent combat: expansion into neutral land has no
        // resolvable target and would drown the feed.
        const target = resolver.bySmallId(attack.targetID);
        const actor = resolver.bySmallId(player.smallID);
        if (actor === null || target === null || actor === target) continue;
        push({
          kind: "attack",
          actor,
          target,
          detail: null,
          turn: turnNumber,
        });
      }
    }
    for (const raw of update.updates[GameUpdateType.Unit] ?? []) {
      const unit = raw as UnitUpdate;
      if (!NUKE_UNIT_TYPES.has(unit.unitType as unknown as string)) continue;
      if (!unit.isActive || this.seenNukeIds.has(unit.id)) continue;
      this.rememberNuke(unit.id);
      const actor = resolver.bySmallId(unit.ownerID);
      if (actor === null) continue;
      push({ kind: "nuke", actor, target: null, detail: null, turn: turnNumber });
    }
    return events;
  }

  private pair(
    kind: PremiereWarEventKind,
    actorSmallId: number,
    targetSmallId: number,
    resolver: PremiereWarNameResolver,
    context: { turn: number },
  ): PremiereWarEvent | null {
    const actor = resolver.bySmallId(actorSmallId);
    const target = resolver.bySmallId(targetSmallId);
    if (actor === null || target === null) return null;
    return { kind, actor, target, detail: null, turn: context.turn };
  }

  private rememberAttack(id: string): void {
    this.seenAttackIds.add(id);
    trimHalf(this.seenAttackIds);
  }

  private rememberNuke(id: number): void {
    this.seenNukeIds.add(id);
    trimHalf(this.seenNukeIds);
  }
}

function trimHalf(set: Set<string> | Set<number>): void {
  if (set.size <= MAX_TRACKED_IDS) return;
  let remaining = Math.floor(set.size / 2);
  for (const value of set) {
    if (remaining <= 0) break;
    (set as Set<unknown>).delete(value);
    remaining -= 1;
  }
}
