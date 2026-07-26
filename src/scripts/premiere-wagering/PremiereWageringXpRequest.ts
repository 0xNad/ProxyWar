/**
 * Creates and downloads a private, sealed pre-simulation episode by running
 * the full active league roster through a Softmax `xp-request`
 * (experience-request) instead of a public league round.
 *
 * WHY xp-request, not the public league (see PremiereWageringProvenance.ts
 * for the full argument): `docs/project-state/softmax-platform-feedback.md`
 * item 26 reproduces cross-account that a non-requester gets 404 reading an
 * xp-request episode directly — only the requesting account (us) can see it
 * before we choose to reveal it. A public league round's result is public on
 * Observatory the instant it completes, independent of anything this repo
 * does, so it can never be genuinely sealed.
 *
 * MUTATES HOSTED STATE (creates and runs a real match, real platform cost —
 * `outputs/seat-tester.sh`'s working comment: "~$0.10-0.20/game"). This is
 * the one script in `premiere-wagering/**` that is operator-gated, the same
 * way `outputs/seat-tester.sh` is: explicit CLI invocation only, never part
 * of an automatic loop.
 *
 * The mutating call itself goes through the SAME proven path
 * `outputs/seat-tester.sh` already uses in production —
 * `uvx --from coworld python -u -` driving
 * `coworld.api_client.CoworldApiClient` directly — because that is the only
 * verified-working way to hit `POST /v2/experience-requests` in this repo;
 * the TypeScript `coworld` CLI wrapper used elsewhere here
 * (`coworldJson`/`defaultCoworldJsonInvoker`) is READ-ONLY BY DESIGN and must
 * stay that way (`coworld-league-mirror.ts:67`).
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseHostedReplayPayload,
  type ParsedHostedReplay,
} from "../../server/agents/CoworldLeagueMirrorCore";
import type { ActiveRosterSeat } from "./PremiereWageringRoster";

export class PremiereWageringXpRequestError extends Error {}

const MAX_REPLAY_BYTES = 512 * 1024 * 1024;

export interface ExperienceRequestRosterSlot {
  readonly player: { readonly policy_ref: string };
  readonly slot: number;
}

export interface ExperienceRequestBody {
  readonly coworld_id: string;
  readonly variant_id: string;
  readonly roster: readonly ExperienceRequestRosterSlot[];
  readonly game_config_overrides: { readonly max_decision_steps: number };
  readonly num_episodes: 1;
}

/**
 * One xp-request roster slot per active policy, in the SAME deterministic
 * order `fetchActiveLeagueRoster` already sorts by (policyVersionId) — the
 * operator directive is "seat every active policy", not a sample.
 */
export function buildExperienceRequestBody(input: {
  readonly coworldId: string;
  readonly variantId: string;
  readonly seats: readonly ActiveRosterSeat[];
  readonly maxDecisionSteps: number;
}): ExperienceRequestBody {
  if (input.seats.length === 0) {
    throw new PremiereWageringXpRequestError(
      "cannot build an experience-request with zero seats",
    );
  }
  return {
    coworld_id: input.coworldId,
    variant_id: input.variantId,
    roster: input.seats.map((seat, slot) => ({
      player: { policy_ref: seat.policyVersionId },
      slot,
    })),
    game_config_overrides: { max_decision_steps: input.maxDecisionSteps },
    num_episodes: 1,
  };
}

export interface CompletedExperienceRequest {
  readonly experienceRequestId: string;
  readonly episodeId: string;
  readonly episodeRequestId: string;
  readonly replayUrl: string;
}

export type ExperienceRequestRunner = (
  body: ExperienceRequestBody,
  options: { readonly server: string; readonly pollIntervalMs: number },
) => Promise<CompletedExperienceRequest>;

/**
 * Runs the proven `seat-tester.sh` Python body against an arbitrary roster
 * body instead of a hardcoded keystone+tester pair, streaming its stdout
 * through so an operator watching the terminal sees the same
 * status/completed/failed progress lines seat-tester.sh prints. Parses the
 * SINGLE trailing `PREMIERE_WAGERING_XPREQ_RESULT <json>` line for the
 * structured result; anything else on stdout is progress logging.
 */
export const runExperienceRequestViaCoworldPython: ExperienceRequestRunner =
  async (body, options) => {
    const pythonScript = `
import json, sys, time
from coworld.api_client import CoworldApiClient
body = json.loads(sys.argv[1])
server = sys.argv[2]
poll_interval_s = float(sys.argv[3])
with CoworldApiClient.from_login(server_url=server) as c:
    r = c._http_client.post("/v2/experience-requests", headers=c._headers(), json=body, timeout=120)
    if r.status_code != 200:
        print(f"create FAILED: {r.status_code} {r.text[:500]}", file=sys.stderr)
        sys.exit(1)
    xid = r.json()["id"]
    print(f"experience-request created: {xid} ({len(body['roster'])} seats)")
    for _ in range(1200):
        d = c._http_client.get(f"/v2/experience-requests/{xid}", headers=c._headers(), timeout=30).json()
        st, cc, fc = d.get("status"), d.get("completed_count"), d.get("failed_count")
        print(f"  {st}  completed={cc} failed={fc}")
        if (cc and cc > 0) or (fc and fc > 0) or st in ("completed", "failed"):
            episodes = d.get("episodes") or []
            if not episodes:
                print("no episodes on terminal experience-request", file=sys.stderr)
                sys.exit(1)
            ep = episodes[0]
            epi = c.get_episode_request(ep["id"])
            result = {
                "experienceRequestId": xid,
                "episodeId": ep["id"],
                "episodeRequestId": str(getattr(epi, "episode_id", "") or ""),
                "replayUrl": str(getattr(epi, "replay_url", "") or ""),
            }
            if not result["replayUrl"]:
                print("episode completed but replay_url is empty", file=sys.stderr)
                sys.exit(1)
            print("PREMIERE_WAGERING_XPREQ_RESULT " + json.dumps(result))
            sys.exit(0)
        time.sleep(poll_interval_s)
    print("experience-request timed out waiting for completion", file=sys.stderr)
    sys.exit(1)
`;
    const server = options.server;
    const stdout = await runPythonSubprocess(
      ["--from", "coworld", "python", "-u", "-"],
      pythonScript,
      [JSON.stringify(body), server, String(options.pollIntervalMs / 1000)],
    );
    const resultLine = stdout
      .split("\n")
      .reverse()
      .find((line) => line.startsWith("PREMIERE_WAGERING_XPREQ_RESULT "));
    if (resultLine === undefined) {
      throw new PremiereWageringXpRequestError(
        "experience-request subprocess did not print a result line",
      );
    }
    return JSON.parse(
      resultLine.slice("PREMIERE_WAGERING_XPREQ_RESULT ".length),
    ) as CompletedExperienceRequest;
  };

// `new Promise(executor)` here (not `Promise.withResolvers`, which needs
// ES2024 lib — this project targets ES2022) — this is the "API specifically
// requires the executor form" case: bridging a callback-style child process
// into a promise.
function runPythonSubprocess(
  uvxArgs: string[],
  pythonScript: string,
  scriptArgs: string[],
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("uvx", [...uvxArgs, ...scriptArgs], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new PremiereWageringXpRequestError(`coworld python exited ${code}`),
        );
    });
    child.stdin.write(pythonScript);
    child.stdin.end();
  });
}

/** Downloads the raw `.replay` JSON at `replayUrl` (bounded, matching the
 * same `maximumReplayBytes` ceiling `coworld-league-mirror.ts` uses). */
export async function downloadRawReplay(replayUrl: string): Promise<unknown> {
  const response = await fetch(replayUrl);
  if (!response.ok) {
    throw new PremiereWageringXpRequestError(
      `replay download failed: ${response.status} ${response.statusText}`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_REPLAY_BYTES) {
    throw new PremiereWageringXpRequestError(
      `replay exceeds ${MAX_REPLAY_BYTES}-byte bound`,
    );
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_REPLAY_BYTES) {
    throw new PremiereWageringXpRequestError(
      `replay exceeds ${MAX_REPLAY_BYTES}-byte bound`,
    );
  }
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

/**
 * Writes the private local bundle from a downloaded raw replay payload — the
 * SAME `decisions.jsonl` / `game-record.json` / `match-summary.json` /
 * `spectator-replay.json` shape `coworld-league-mirror.ts` writes, reusing
 * its exact `parseHostedReplayPayload` parser, but WITHOUT that script's
 * public-key rewrite (`league-${runID}`): the runID is kept verbatim and the
 * bundle is written under `xpreq-<runID>`, which never matches
 * `isManagedPublicRunKey` — this bundle must never look like something the
 * mirror/demo-server's public path pattern would serve.
 */
export async function writeXpRequestBundle(input: {
  readonly rawReplayPayload: unknown;
  readonly runsRootDir: string;
}): Promise<{ readonly bundleDir: string; readonly parsed: ParsedHostedReplay }> {
  const parsed = parseHostedReplayPayload(input.rawReplayPayload);
  if (parsed === null) {
    throw new PremiereWageringXpRequestError(
      "unrecognized raw replay payload shape",
    );
  }
  if (parsed.spectatorReplay === null) {
    throw new PremiereWageringXpRequestError(
      "raw replay payload has no spectator replay data",
    );
  }
  const bundleDirName = `xpreq-${parsed.runID}`;
  const bundleDir = path.join(path.resolve(input.runsRootDir), bundleDirName);
  await fs.mkdir(bundleDir, { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(parsed.inlineRunArtifacts)) {
    await fs.writeFile(path.join(bundleDir, name), contents, "utf8");
  }
  await fs.writeFile(
    path.join(bundleDir, "spectator-replay.json"),
    `${JSON.stringify(parsed.spectatorReplay, null, 2)}\n`,
    "utf8",
  );
  return { bundleDir, parsed };
}
