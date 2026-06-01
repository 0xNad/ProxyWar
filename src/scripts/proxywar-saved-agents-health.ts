import {
  formatProxyWarSavedAgentMaintenanceReport,
  maintainProxyWarSavedExternalAgents,
} from "../server/agents/ProxyWarSavedAgentMaintenance";

const args = process.argv.slice(2);
const json = args.includes("--json");
const archiveFailed = args.includes("--archive-failed");

const report = await maintainProxyWarSavedExternalAgents({ archiveFailed });

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    `${formatProxyWarSavedAgentMaintenanceReport(report)}\n`,
  );
}

if (report.failedExternalAgentCount > 0) {
  process.exitCode = archiveFailed ? 0 : 1;
}
