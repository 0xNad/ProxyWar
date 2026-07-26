/**
 * ProxyWar guard — omp port of .claude/hooks/guard-core.sh and guard-unattended.sh
 *
 * Why this exists as a hook rather than settings: omp's approval config is
 * per-TOOL (`tools.approval.bash: prompt`), not per-COMMAND. The operator-gated
 * actions here are command-shaped ("git push" yes, "git status" no), so they can
 * only be expressed in code. Like the Claude Code originals, this fires in every
 * approval mode, including `yolo`.
 *
 * FAIL-OPEN by design. omp blocks the tool call if a hook throws, so every
 * handler body is wrapped: any unexpected shape or internal error allows the
 * call. A bug here can never block legitimate engineering work — worst case it
 * fails to block something, degrading to the behavioural standard in RULES.md.
 *
 * Scope note vs the shell originals: those matched only Claude Code's `Bash`
 * tool. omp can also execute through `eval` (persistent Python/JS cells) and
 * `ssh`, so the destructive rules below scan those too. Matching only `bash`
 * would have silently weakened the guard on this harness.
 *
 * Overrides, unchanged from the originals:
 *   PROXYWAR_ALLOW_CORE_LLM=1   — allow a reviewed src/core provider exception
 *   PROXYWAR_ALLOW_DANGEROUS=1  — allow gated actions (set in the harness env)
 *   /tmp/proxywar-allow-dangerous-once — touch it in a separate, sandbox-disabled
 *     command run; gated actions are allowed while it exists and is under 10
 *     minutes old. Not consumed on use; an expired marker is removed and the
 *     action blocks normally. rm it once the approved action is done.
 */

import { existsSync, statSync, unlinkSync } from "node:fs";

const MARKER = "/tmp/proxywar-allow-dangerous-once";
const MARKER_TTL_MS = 10 * 60 * 1000;

/** Tools that can put bytes on disk. */
const WRITE_TOOLS = new Set(["write", "edit", "ast_edit"]);
/** Tools that can execute a shell command. */
const EXEC_TOOLS = new Set(["bash", "eval", "ssh"]);

/** LLM/provider logic entering src/core. Generic fetch/http stays allowed. */
const CORE_LLM =
  /from\s+['"][@a-z0-9/_.-]*(openai|anthropic|langchain|ollama)|require\(\s*['"][^'"]*(openai|anthropic|langchain)|[A-Za-z]*LlmProvider|CodexCli|codex-cli|AI_LEAGUE_LLM_PROVIDER/i;

interface Rule {
  re: RegExp;
  why: string;
}

const DESTRUCTIVE: Rule[] = [
  {
    re: /\bgit\b[^|;&]*\bpush\b/i,
    why: "git push (push is operator-gated; never push to any remote unprompted)",
  },
  { re: /git +(rebase|filter-branch)/i, why: "git history rewrite (rebase/filter-branch)" },
  { re: /git +reset +--hard/i, why: "git reset --hard (destructive)" },
  { re: /git +branch +(-[dD]|--delete)/i, why: "git branch deletion" },
  { re: /npm +publish/i, why: "npm publish" },
  {
    re: /git +clean +[^|;&]*-[a-zA-Z]*[xX]/i,
    why: "git clean -x/-X (would delete gitignored artifacts/)",
  },
  {
    re: /coworld +(upload|submit|publish)|upload-coworld|upload-policy|--execute-hosted|PROXYWAR_ALLOW_SOFTMAX/i,
    why: "hosted Coworld upload/submit/publish",
  },
];

/** Mutating the live beta env / ~/.open-frontier. Reads stay allowed. */
const LIVE_ENV = /open-frontier[a-z0-9-]*\.env|\.open-frontier\//i;
const LIVE_ENV_MUTATION = /sed +-i|tee |[^>]>[^>]| >>|\bmv \b|\brm \b|\bcp \b/i;

/** Deleting evidence under artifacts/ or backups/ (the wrapper's own dir is fine). */
const EVIDENCE_DELETE = /rm +[^|;&]*(artifacts|backups)/i;

/** True while the operator's approval window is open. */
function operatorApproved(): boolean {
  if (process.env.PROXYWAR_ALLOW_DANGEROUS === "1") return true;
  try {
    if (!existsSync(MARKER)) return false;
    const age = Date.now() - statSync(MARKER).mtimeMs;
    if (age < MARKER_TTL_MS) return true;
    unlinkSync(MARKER); // expired: clean up, then block normally
  } catch {
    /* ignore — absent or unreadable marker means no approval */
  }
  return false;
}

/** Every string anywhere in a tool input, so we don't have to guess key names. */
function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 500) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  return out;
}

function targetPath(input: Record<string, unknown>): string {
  for (const key of ["path", "file_path", "filePath", "file", "target", "filename"]) {
    const v = input?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function blockedReason(command: string): string | null {
  const c = command.replace(/\n/g, " ");
  for (const rule of DESTRUCTIVE) if (rule.re.test(c)) return rule.why;

  // Let the auto-resume wrapper manage its own backup dir.
  const cSafe = c.replace(/auto-resume-backups/g, "_wrapperdir_");
  if (EVIDENCE_DELETE.test(cSafe)) return "deleting/archiving under artifacts/ or backups/";

  if (LIVE_ENV.test(c) && LIVE_ENV_MUTATION.test(c))
    return "mutating the live beta env / ~/.open-frontier (deploy/env-rename is operator-gated; reads are fine)";

  return null;
}

export default function hook(pi: any): void {
  pi.on("tool_call", async (event: any) => {
    try {
      const tool = String(event?.toolName ?? "");
      const input = (event?.input ?? {}) as Record<string, unknown>;

      // --- Guard 1: no LLM/provider logic in src/core ---
      if (WRITE_TOOLS.has(tool) && process.env.PROXYWAR_ALLOW_CORE_LLM !== "1") {
        const path = targetPath(input);
        if (path.includes("src/core/")) {
          const wrote = collectStrings(input).join("\n");
          if (CORE_LLM.test(wrote)) {
            return {
              block: true,
              reason:
                "BLOCKED: introduces LLM/provider logic into src/core (AGENTS.md). " +
                "Generic fetch/http is fine; LLM/provider modules are not. " +
                "Override: PROXYWAR_ALLOW_CORE_LLM=1 for a deliberate, reviewed exception.",
            };
          }
        }
      }

      // --- Guard 2: destructive / operator-gated commands ---
      if (EXEC_TOOLS.has(tool)) {
        const command =
          typeof input.command === "string" ? input.command : collectStrings(input).join("\n");
        const why = blockedReason(command);
        if (why && !operatorApproved()) {
          return {
            block: true,
            reason:
              `BLOCKED [guard v3] (unattended safety): ${why}. This is on the operator's ` +
              "log-and-skip list — record it as blocked-needs-me in decision-log.md and move to " +
              "the next item; do NOT retry. (Operator-approved override: in a SEPARATE prior " +
              "command run with the sandbox DISABLED, touch /tmp/proxywar-allow-dangerous-once — " +
              "gated actions are then allowed for 10 minutes; rm the marker when done.)",
          };
        }
      }
    } catch {
      // Fail open: never let a bug in this hook block real work.
    }
    return undefined;
  });
}
