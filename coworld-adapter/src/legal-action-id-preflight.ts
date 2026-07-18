import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LegalActionIDPreflightIssueType =
  | "missing_decision_rows"
  | "missing_legal_action_ids"
  | "legal_action_id_group_drift"
  | "blank_legal_action_id"
  | "duplicate_legal_action_id"
  | "missing_selected_legal_action_id"
  | "selected_not_uniquely_offered";

export interface LegalActionIDPreflightIssue {
  rowIndex: number;
  sequence: number | null;
  turnNumber: number | null;
  type: LegalActionIDPreflightIssueType;
  actionID: string | null;
  occurrences: number | null;
}

export interface LegalActionIDPreflightReport {
  schemaVersion: 1;
  gatePassed: boolean;
  decisionRows: number;
  offeredActionIDs: number;
  source: {
    replayPath: string | null;
    replaySha256: string | null;
  };
  issues: LegalActionIDPreflightIssue[];
}

export function inspectDecisionLegalActionIDs(
  rows: readonly unknown[],
): LegalActionIDPreflightReport {
  const issues: LegalActionIDPreflightIssue[] = [];
  let offeredActionIDs = 0;

  if (rows.length === 0) {
    issues.push({
      rowIndex: -1,
      sequence: null,
      turnNumber: null,
      type: "missing_decision_rows",
      actionID: null,
      occurrences: null,
    });
  }

  rows.forEach((value, rowIndex) => {
    const row = record(value);
    const sequence = integerOrNull(row?.sequence);
    const turnNumber = integerOrNull(row?.turnNumber);
    const ids = stringArray(row?.legalActionIDs);

    if (ids === null || ids.length === 0) {
      issues.push({
        rowIndex,
        sequence,
        turnNumber,
        type: "missing_legal_action_ids",
        actionID: null,
        occurrences: null,
      });
      return;
    }

    const byKind = record(row?.legalActionIDsByKind);
    const groupedIDs = byKind === null ? null : flattenOfferedIDs(byKind);
    if (groupedIDs === null || !sameIDMultiset(ids, groupedIDs)) {
      issues.push({
        rowIndex,
        sequence,
        turnNumber,
        type: "legal_action_id_group_drift",
        actionID: null,
        occurrences: null,
      });
    }

    offeredActionIDs += ids.length;
    const counts = new Map<string, number>();
    for (const id of ids) {
      if (id.trim().length === 0) {
        issues.push({
          rowIndex,
          sequence,
          turnNumber,
          type: "blank_legal_action_id",
          actionID: id,
          occurrences: null,
        });
        continue;
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    for (const [actionID, occurrences] of [...counts.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (occurrences > 1) {
        issues.push({
          rowIndex,
          sequence,
          turnNumber,
          type: "duplicate_legal_action_id",
          actionID,
          occurrences,
        });
      }
    }

    const selected = row?.selectedLegalActionId;
    if (typeof selected !== "string" || selected.trim().length === 0) {
      issues.push({
        rowIndex,
        sequence,
        turnNumber,
        type: "missing_selected_legal_action_id",
        actionID: null,
        occurrences: null,
      });
      return;
    }
    const selectedOccurrences = counts.get(selected) ?? 0;
    if (selectedOccurrences !== 1) {
      issues.push({
        rowIndex,
        sequence,
        turnNumber,
        type: "selected_not_uniquely_offered",
        actionID: selected,
        occurrences: selectedOccurrences,
      });
    }
  });

  return {
    schemaVersion: 1,
    gatePassed: issues.length === 0,
    decisionRows: rows.length,
    offeredActionIDs,
    source: {
      replayPath: null,
      replaySha256: null,
    },
    issues,
  };
}

export async function inspectReplayLegalActionIDs(
  replayPath: string,
): Promise<LegalActionIDPreflightReport> {
  const resolvedPath = path.resolve(replayPath);
  const replayBytes = await readFile(resolvedPath);
  const replay = record(JSON.parse(replayBytes.toString("utf8")));
  const artifacts = record(replay?.inlineRunArtifacts);
  const jsonl = artifacts?.["decisions.jsonl"];
  if (typeof jsonl !== "string" || jsonl.trim().length === 0) {
    throw new Error("replay is missing inlineRunArtifacts decisions.jsonl");
  }
  const rows = jsonl
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  return {
    ...inspectDecisionLegalActionIDs(rows),
    source: {
      replayPath: resolvedPath,
      replaySha256: createHash("sha256").update(replayBytes).digest("hex"),
    },
  };
}

function flattenOfferedIDs(byKind: Record<string, unknown>): string[] | null {
  const ids: string[] = [];
  for (const value of Object.values(byKind)) {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      return null;
    }
    ids.push(...(value as string[]));
  }
  return ids;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

function sameIDMultiset(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const id of left) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of right) {
    const remaining = counts.get(id) ?? 0;
    if (remaining === 0) {
      return false;
    }
    counts.set(id, remaining - 1);
  }
  return true;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

async function main(): Promise<void> {
  const replayPath = process.argv[2];
  if (replayPath === undefined) {
    throw new Error("usage: legal-action-id-preflight.ts <replay.json>");
  }
  const report = await inspectReplayLegalActionIDs(path.resolve(replayPath));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.gatePassed) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`legal-action-id preflight failed: ${message}\n`);
    process.exitCode = 1;
  });
}
