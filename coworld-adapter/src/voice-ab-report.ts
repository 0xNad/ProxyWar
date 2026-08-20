/**
 * Within-policy voice A/B report.
 *
 * Answers the one question the league cannot answer observationally: does a
 * message before a proposal change whether that proposal is accepted? The
 * naive league split (messaged pairs 22.9% vs unmessaged 15.1%) is a
 * BETWEEN-policy artifact — talkers message essentially every counterparty,
 * so the two groups are different agents, not different treatments.
 *
 * This reads the arms back out of episodes run by a policy with
 * `PROXYWAR_KEYSTONE_VOICE_AB` set, RECOMPUTING each rival's assignment from
 * `keystoneVoiceCohort(gameID, ownID, rivalID, share)`. Recomputation is the
 * point: absence of a message is otherwise ambiguous between "assigned
 * silent" and "never had the opportunity", and only the first is a control.
 *
 * Usage:
 *   node --import tsx coworld-adapter/src/voice-ab-report.ts \
 *     --agent "Auri" --share 0.5 [--dir artifacts/ai-league-runs] [--since 2026-08-19]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keystoneVoiceCohort } from "./keystone-player";

type Outcome = "accepted" | "rejected" | "expired" | "withdrawn" | "other";

interface ArmTally {
  accepted: number;
  rejected: number;
  expired: number;
  withdrawn: number;
  other: number;
  messagesSent: number;
  rivals: Set<string>;
}

const emptyArm = (): ArmTally => ({
  accepted: 0,
  rejected: 0,
  expired: 0,
  withdrawn: 0,
  other: 0,
  messagesSent: 0,
  rivals: new Set<string>(),
});

function arg(flag: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function outcomeOf(deal: Record<string, unknown>): Outcome {
  const raw = String(deal.status ?? deal.state ?? "").toLowerCase();
  if (raw === "accepted" || raw === "fulfilled") return "accepted";
  if (raw === "rejected") return "rejected";
  if (raw === "expired") return "expired";
  if (raw === "withdrawn") return "withdrawn";
  return "other";
}

/** Two-proportion z-test. Reported so a small sample cannot masquerade. */
function zTest(
  a: number,
  na: number,
  b: number,
  nb: number,
): { z: number; p: number } | null {
  if (na === 0 || nb === 0) return null;
  const pooled = (a + b) / (na + nb);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
  if (se === 0) return null;
  const z = (a / na - b / nb) / se;
  // Two-sided normal tail via Abramowitz-Stegun 7.1.26 erf approximation.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return { z, p: 1 - erf };
}

function main(): void {
  const agent = arg("--agent");
  const share = Number(arg("--share", "0.5"));
  const dir = arg("--dir", "artifacts/ai-league-runs") as string;
  const since = arg("--since", "");
  if (!agent || !Number.isFinite(share) || share <= 0 || share >= 1) {
    console.error(
      "usage: voice-ab-report.ts --agent <username> --share <0..1> [--dir <path>] [--since <prefix>]",
    );
    process.exit(2);
  }

  const arms: Record<"talk" | "silent", ArmTally> = {
    talk: emptyArm(),
    silent: emptyArm(),
  };
  let episodes = 0;
  let episodesWithAgent = 0;

  for (const entry of fs.readdirSync(dir)) {
    if (since && !entry.includes(since)) continue;
    const base = path.join(dir, entry);
    const record = readJson(path.join(base, "game-record.json")) as {
      info?: { gameID?: string; players?: Array<Record<string, unknown>> };
      turns?: Array<{ intents?: Array<Record<string, unknown>> }>;
    } | null;
    const telemetry = readJson(path.join(base, "spectator-telemetry.json")) as {
      agents?: Array<Record<string, unknown>>;
    } | null;
    const ledger = readJson(path.join(base, "deal-ledger.json")) as
      | { deals?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>
      | null;
    if (!record || !telemetry) continue;
    episodes += 1;

    const byPlayerID = new Map<string, string>();
    let ownID: string | undefined;
    for (const view of telemetry.agents ?? []) {
      const id = String(view.playerID ?? "");
      const name = String(view.username ?? "");
      byPlayerID.set(id, name);
      if (name === agent) ownID = id;
    }
    if (ownID === undefined) continue;
    episodesWithAgent += 1;
    const gameID = String(record.info?.gameID ?? "");

    const armOf = (rivalID: string): "talk" | "silent" =>
      keystoneVoiceCohort(gameID, ownID as string, rivalID, share)
        ? "talk"
        : "silent";

    const clientToName = new Map<string, string>();
    for (const player of record.info?.players ?? []) {
      clientToName.set(
        String(player.clientID ?? ""),
        String(player.username ?? ""),
      );
    }
    for (const turn of record.turns ?? []) {
      for (const intent of turn.intents ?? []) {
        if (String(intent.type) !== "agent_message") continue;
        if (clientToName.get(String(intent.clientID)) !== agent) continue;
        const rivalID = String(intent.recipient ?? "");
        const arm = armOf(rivalID);
        arms[arm].messagesSent += 1;
        arms[arm].rivals.add(rivalID);
      }
    }

    const deals = Array.isArray(ledger) ? ledger : (ledger?.deals ?? []);
    for (const deal of deals) {
      const proposer = String(deal.proposerPlayerID ?? "");
      const recipient = String(deal.recipientPlayerID ?? "");
      if (proposer !== ownID && recipient !== ownID) continue;
      const rivalID = proposer === ownID ? recipient : proposer;
      arms[armOf(rivalID)][outcomeOf(deal)] += 1;
    }
  }

  const answerable = (arm: ArmTally): number =>
    arm.accepted + arm.rejected + arm.expired;

  console.log(
    `agent=${agent} share=${share} dir=${dir}${since ? ` since=${since}` : ""}`,
  );
  console.log(
    `episodes scanned=${episodes} with agent seated=${episodesWithAgent}`,
  );
  for (const key of ["talk", "silent"] as const) {
    const arm = arms[key];
    const n = answerable(arm);
    const pct = n > 0 ? ((100 * arm.accepted) / n).toFixed(1) : "n/a";
    console.log(
      `  ${key.padEnd(6)} rivals=${arm.rivals.size} messages=${arm.messagesSent} ` +
        `accepted=${arm.accepted} rejected=${arm.rejected} expired=${arm.expired} ` +
        `withdrawn=${arm.withdrawn} | acceptance=${pct}% of ${n}`,
    );
  }
  // A silent arm that still sent messages means the assignment did not reach
  // the player — the report is invalid, not merely null.
  if (arms.silent.messagesSent > 0) {
    console.log(
      `\nINVALID: ${arms.silent.messagesSent} message(s) went to the SILENT arm. ` +
        `Either the policy was not running the experiment build, or --share does not match its env.`,
    );
    process.exit(1);
  }
  const test = zTest(
    arms.talk.accepted,
    answerable(arms.talk),
    arms.silent.accepted,
    answerable(arms.silent),
  );
  console.log(
    test
      ? `\nz=${test.z.toFixed(2)} p=${test.p.toFixed(3)} (two-sided, unpaired)`
      : "\nno test: an arm has no answerable deals yet",
  );
  if (answerable(arms.talk) < 30 || answerable(arms.silent) < 30) {
    console.log(
      "UNDERPOWERED: fewer than 30 answerable deals in an arm — collect more episodes before reading the result.",
    );
  }
}

// Run ONLY when invoked as a script. `main()` at module scope calls
// `process.exit(2)` when `--agent` is absent, so the first test (or tool) that
// imports anything from this file would kill its own worker before running a
// single assertion. Nothing imports it today; this keeps that true by accident
// rather than by luck.
// Use fileURLToPath, NOT `new URL(import.meta.url).pathname`: the latter leaves
// the path percent-encoded, so any directory containing a space — which on this
// machine is most of them ("ProxyWar Workspace", "Crucial X9", "Application
// Support") — never matches the resolved argv and the script silently stops
// running. Verified both directions: importing prints nothing and exits 0,
// invoking directly still prints usage and exits 2.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
