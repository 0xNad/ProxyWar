/**
 * The SHARED stated-reason content policy: one denylist, one cap, used by
 * every surface that publishes agent-authored rationale text.
 *
 * LINEAGE NOTE: upstream (`origin/main`) this policy lives inside
 * `AgentDecisiveMoments.ts` and is imported from there. That module — and the
 * `AgentMatchStateDerivations` / `AgentMatchStateSeries` / `AgentMatchRecap`
 * decisive-moments web it belongs to — is NOT present on this betting-free
 * release lineage. The code below is lifted VERBATIM from
 * `AgentDecisiveMoments.ts` so the policy is defined exactly once here and
 * `AgentDealCompliance.sanitizeDealStatedReason` composes it rather than
 * forking the denylist. When the decisive-moments web lands on this lineage,
 * delete this module and repoint the import (or have
 * `AgentDecisiveMoments.ts` re-export from here) — do NOT end up with two
 * copies of the denylist.
 *
 * P0 production fix: a real match's `decisive-moments.json` shipped
 * `LLM decision rejected (LLM provider failed: HTTP 403 "Invalid API Key
 * format"); fallback: ...` — a raw upstream LLM-provider error — as an
 * agent's public "stated reason". Traced to `LlmAgentBrain.ts`'s
 * `decide()`/`fallback()`: a provider failure (network error, malformed
 * response, or here an auth error) is folded into the SAME
 * `AgentDecision.reason` field a genuine stated reason uses, with no
 * distinction at the point of recording — see
 * `docs/project-state/known-problems.md` for that upstream finding.
 * FIXING THE RECORDER IS OUT OF SCOPE HERE (a separate concern from a
 * different subsystem); this module's job is to never SHIP one publicly
 * regardless of how it was recorded, so the filter is deliberately
 * conservative and lives entirely on the OUTPUT side.
 *
 * `null` (never shipped, never the raw string) whenever the candidate
 * text:
 *  - is empty/whitespace-only, or exceeds `STATED_REASON_MAX_LENGTH` —
 *    a genuine spoken-style reason is a short sentence, not a blob;
 *  - does not START with a letter — rejects JSON/object-shaped payloads
 *    (`{...}`, `[...]`), numeric codes, and other non-prose openers;
 *  - matches ANY denylist pattern: HTTP status/error vocabulary,
 *    exception/stack-trace shapes, or provider/network-failure
 *    vocabulary (the EXACT shape the real incident above produced).
 *
 * Conservative on purpose: a plausible false positive (a genuine reason
 * that happens to use a denylisted word) is an acceptable cost for never
 * shipping a false negative (real junk reaching a public page) — the
 * field degrades to an honestly-absent row either way, never a
 * placeholder.
 */
export const STATED_REASON_MAX_LENGTH = 400;
const STATED_REASON_DENYLIST_PATTERNS: readonly RegExp[] = [
  // HTTP status/error response shapes.
  /\bhttp\/?\s*\d{3}\b/i,
  /\b(400|401|402|403|404|405|408|409|429|500|502|503|504)\b/,
  // Generic error/exception vocabulary — the words an error MESSAGE uses,
  // not the words an agent uses to explain a military/diplomatic choice.
  /\b(error|exception|invalid|unauthorized|forbidden|time(d)?[\s-]?out|failed|failure|rejected)\b/i,
  /\b(traceback|stack trace|stacktrace)\b/i,
  // Provider/network failure vocabulary — the exact shape the real
  // incident this fix exists for produced.
  /\bapi[\s-]?key\b/i,
  /\b(provider failed|econnrefused|enotfound|fetch failed|network error|rate limit(ed)?)\b/i,
  // Stack-trace-ish source locations (`foo.ts:42`, `at fn (file:1:2)`).
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs):\d+/,
  /\bat\s+\S+\s*\([^)]*:\d+:\d+\)/,
];

export function sanitizeStatedReason(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > STATED_REASON_MAX_LENGTH) return null;
  if (!/^[A-Za-z]/.test(text)) return null;
  if (STATED_REASON_DENYLIST_PATTERNS.some((pattern) => pattern.test(text)))
    return null;
  return text;
}
