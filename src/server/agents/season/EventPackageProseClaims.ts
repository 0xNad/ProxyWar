import type { EventPackageClaim } from "./EventPackage";

/**
 * Season Zero activation prompt Phase 4 item 4 ("Event package"): "The
 * operator may edit prose, but the system must flag factual claims that
 * do not map to known data." Deliberately CONSERVATIVE and NEVER
 * blocking — this only WARNS an operator; `premiere:package` prints these
 * warnings and still saves the package (spec doesn't ask for a hard
 * block, and a false positive here must never stop an operator from
 * shipping a correct package).
 *
 * Two narrow, cheap-to-explain signals, checked against the package's own
 * `reasonToWatch.claims[]` (never against `FeaturedMatch.evidence.notes`
 * or any other free text — `claims[]` is the one place a factual
 * assertion is supposed to be grounded):
 *
 * 1. A standalone number in the prose (e.g. "four of its last five") that
 *    does not appear verbatim in ANY claim's own `text` — numbers are the
 *    cheapest, least ambiguous "this looks like a specific factual
 *    assertion" signal a lightweight regex can catch without any NLP.
 * 2. A KNOWN agent display name mentioned in the prose that does not
 *    appear verbatim in any claim's own `text` — catches "Sefirot's
 *    Pangaea record is dominant" prose with no backing claim, without
 *    requiring the checker to understand grammar.
 *
 * Both are substring checks, not semantic verification — a claim's `text`
 * merely needs to ALREADY contain the same token for the number/name to
 * be considered "covered". This intentionally cannot prove a claim is
 * TRUE, only that the prose isn't introducing a number or name with zero
 * corresponding evidence entry at all.
 */

const STANDALONE_NUMBER_PATTERN = /\b\d+(\.\d+)?\b/g;

export function findUnreferencedProseClaims(
  prose: string,
  claims: readonly EventPackageClaim[],
  knownAgentDisplayNames: readonly string[],
): string[] {
  const warnings: string[] = [];
  const claimText = claims.map((claim) => claim.text).join("\n");

  const proseNumbers = prose.match(STANDALONE_NUMBER_PATTERN) ?? [];
  const uncoveredNumbers = new Set(
    proseNumbers.filter((token) => !claimText.includes(token)),
  );
  for (const token of uncoveredNumbers) {
    warnings.push(
      `prose contains the number "${token}" with no matching reasonToWatch.claims[] entry backing it`,
    );
  }

  for (const name of knownAgentDisplayNames) {
    if (name.trim().length === 0) continue;
    if (prose.includes(name) && !claimText.includes(name)) {
      warnings.push(
        `prose mentions "${name}" with no matching reasonToWatch.claims[] entry backing it`,
      );
    }
  }

  return warnings;
}
