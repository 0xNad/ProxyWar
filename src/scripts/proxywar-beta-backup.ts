import { execFileSync } from "child_process";
import fs from "fs/promises";
import path from "path";

interface BackupEntry {
  label: string;
  source: string;
  destination: string;
  copied: boolean;
  missing: boolean;
}

const args = process.argv.slice(2);
const cwd = process.cwd();
const backupID =
  stringArg(args, "--backup-id=") ?? new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot =
  stringArg(args, "--output-dir=") ??
  process.env.PROXYWAR_BACKUP_DIR ??
  path.join(cwd, "artifacts", "proxywar", "backups");
const destinationRoot = path.join(backupRoot, backupID);
const includeMatchArtifacts = args.includes("--include-match-artifacts");
const nationsDir =
  stringArg(args, "--nations-dir=") ??
  process.env.PROXYWAR_NATIONS_DIR ??
  path.join(cwd, "artifacts", "proxywar", "nations");

const runtimeSources = [
  ["jobs", path.join(cwd, "artifacts", "ai-league-demo-jobs")],
  ["saved-nations", nationsDir],
  ["active-roster", path.join(cwd, "artifacts", "proxywar", "active-roster")],
  ["feedback", path.join(cwd, "artifacts", "proxywar", "beta-feedback")],
  ["external-agent-secrets", path.join(cwd, "artifacts", "proxywar", "secrets")],
  ["rate-limits", path.join(cwd, "artifacts", "proxywar", "rate-limits.json")],
] as const;
const matchArtifactSources = [
  ["runs", path.join(cwd, "artifacts", "ai-league-runs")],
  ["tournaments", path.join(cwd, "artifacts", "ai-league-tournaments")],
] as const;
const sources = includeMatchArtifacts
  ? [...runtimeSources, ...matchArtifactSources]
  : runtimeSources;

await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
const entries: BackupEntry[] = [];
for (const [label, source] of sources) {
  const destination = path.join(destinationRoot, label);
  entries.push(await copyIfPresent(label, source, destination));
}

const manifest = {
  backupID,
  createdAt: new Date().toISOString(),
  gitCommit: git(["rev-parse", "HEAD"]),
  originUrl: git(["config", "--get", "remote.origin.url"]),
  destinationRoot,
  includeMatchArtifacts,
  entries,
  note:
    "This backup may include private tester feedback and external-agent bearer-token secrets. Store it as sensitive data. Historical match artifacts are only included when --include-match-artifacts is passed.",
};

await fs.writeFile(
  path.join(destinationRoot, "backup-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
);

console.log("Proxy War beta backup created", {
  backupID,
  destinationRoot,
  copied: entries.filter((entry) => entry.copied).map((entry) => entry.label),
  missing: entries.filter((entry) => entry.missing).map((entry) => entry.label),
});

async function copyIfPresent(
  label: string,
  source: string,
  destination: string,
): Promise<BackupEntry> {
  try {
    await fs.stat(source);
  } catch {
    return { label, source, destination, copied: false, missing: true };
  }
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
  return { label, source, destination, copied: true, missing: false };
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}
