import fs from "fs/promises";
import { parse } from "node-html-parser";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  loadAgentDemoHubModel,
  openFrontierAgentProtocolSchema,
  openFrontierAgentStartJson,
  renderAgentDemoHubHtml,
  renderOpenFrontierAgentStartHtml,
  renderOpenFrontierAdminHtml,
  renderOpenFrontierPublicHtml,
  renderOpenFrontierTesterDashboardHtml,
} from "../../src/server/agents/AgentDemoHub";

describe("AgentDemoHub", () => {
  it("renders a local launch and inspection hub for runs and tournaments", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-demo-hub-"));
    const runsRootDir = path.join(rootDir, "runs");
    const tournamentsRootDir = path.join(rootDir, "tournaments");
    const evaluationsRootDir = path.join(rootDir, "evaluations");
    const nationsDir = path.join(rootDir, "nations");
    const runDir = path.join(runsRootDir, "hub-run");
    const previousRunDir = path.join(runsRootDir, "hub-run-before");
    const tournamentDir = path.join(tournamentsRootDir, "hub-tournament");
    const evaluationDir = path.join(evaluationsRootDir, "hub-eval");

    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.mkdir(previousRunDir, { recursive: true });
      await fs.mkdir(tournamentDir, { recursive: true });
      await fs.mkdir(evaluationDir, { recursive: true });
      await fs.mkdir(nationsDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "match-summary.json"),
        JSON.stringify({
          runID: "hub-run",
          scenario: "actions",
          brainMode: "planner-executor",
          runnerMode: "step-locked",
          decisionCount: 8,
          acceptedCount: 8,
          rejectedCount: 0,
          fallbackCount: 0,
          parseFailureCount: 0,
          postSpawnNonHoldActionCount: 3,
          confirmedEffectCount: 5,
          unknownEffectCount: 2,
          failedEffectCount: 0,
          spectator: { snapshotCount: 4 },
          completedAt: "2026-05-09T10:00:00.000Z",
        }),
      );
      await fs.writeFile(path.join(runDir, "spectator.html"), "<html></html>");
      await fs.writeFile(path.join(runDir, "game-record.json"), "{}");
      await fs.writeFile(path.join(runDir, "objective-scorecard.json"), "{}");
      await fs.writeFile(path.join(runDir, "external-agent-feedback.md"), "# Feedback");
      await fs.writeFile(
        path.join(runDir, "external-agent-feedback.json"),
        JSON.stringify({
          schemaVersion: 1,
          runID: "hub-run",
          matchID: "HUBGAME",
          scenario: "actions",
          brainMode: "planner-executor",
          generatedAt: "2026-05-09T10:01:00.000Z",
          aggregate: {
            externalAgentCount: 1,
            decisionCount: 12,
            postSpawnDecisionCount: 10,
            nonHoldCount: 7,
            acceptedCount: 12,
            rejectedCount: 0,
            fallbackCount: 1,
            parserFailureCount: 0,
            confirmedAuditCount: 7,
            unknownAuditCount: 3,
            failedAuditCount: 0,
            externalActionCallCount: 12,
            externalPlannerCallCount: 0,
            nonHoldRate: 0.7,
            acceptedRate: 1,
            auditedEffectRate: 0.7,
            readyForDeveloperReview: false,
            summary:
              "Remote Frontier accepted 12/12 decisions and needs one policy fix before the next run.",
            topSuggestions: [
              "Use observation memory to avoid repeated low-value choices.",
            ],
            iterationCoach: {
              status: "needs_strategy_iteration",
              priorityFixes: [
                "Break repeated low-value action loops before tuning diplomacy.",
              ],
              exampleTurns: [
                {
                  sequence: 9,
                  username: "Remote Frontier",
                  issue: "Repeated an expansion action after a better build was offered",
                  observationSummary: "Remote Frontier had a safe economy build",
                  chosenActionID: "attack-neutral-1",
                  chosenActionKind: "attack",
                  recommendedActionKinds: ["build", "alliance_request"],
                  offeredActionIDs: ["attack-neutral-1", "build-city-1"],
                  policyHint: "Rotate into economy when expansion is no longer highest leverage.",
                },
              ],
              practicePrompts: [
                "Update the policy to rank safe City or Factory builds above repeated expansion.",
              ],
            },
          },
          agents: [
            {
              agentID: "remote-frontier",
              username: "Remote Frontier",
              profile: "opportunistic",
              iterationCoach: {
                status: "needs_strategy_iteration",
                priorityFixes: [
                  "Break repeated low-value action loops before tuning diplomacy.",
                ],
              },
              decisionCount: 12,
              acceptedRate: 1,
              nonHoldRate: 0.7,
              fallbackCount: 1,
              parserFailureCount: 0,
              repeatedActionKindCount: 2,
              repeatedExactActionCount: 1,
              improvementSuggestions: [
                "Use observation memory to avoid repeated low-value choices.",
              ],
              warnings: [],
            },
          ],
        }),
      );
      await fs.writeFile(path.join(runDir, "match-package.html"), "<html></html>");
      await fs.writeFile(path.join(runDir, "match-package.md"), "# Package");
      await fs.writeFile(
        path.join(previousRunDir, "match-summary.json"),
        JSON.stringify({
          runID: "hub-run-before",
          scenario: "actions",
          brainMode: "planner-executor",
          runnerMode: "step-locked",
          decisionCount: 7,
          acceptedCount: 6,
          rejectedCount: 1,
          fallbackCount: 2,
          parseFailureCount: 1,
          postSpawnNonHoldActionCount: 2,
          completedAt: "2026-05-09T09:50:00.000Z",
        }),
      );
      await fs.writeFile(
        path.join(previousRunDir, "external-agent-feedback.md"),
        "# Feedback before",
      );
      await fs.writeFile(
        path.join(previousRunDir, "external-agent-feedback.json"),
        JSON.stringify({
          schemaVersion: 1,
          runID: "hub-run-before",
          matchID: "HUBGAME-BEFORE",
          scenario: "actions",
          brainMode: "planner-executor",
          generatedAt: "2026-05-09T09:51:00.000Z",
          aggregate: {
            externalAgentCount: 1,
            decisionCount: 8,
            postSpawnDecisionCount: 6,
            nonHoldCount: 3,
            acceptedCount: 6,
            rejectedCount: 2,
            fallbackCount: 3,
            parserFailureCount: 1,
            confirmedAuditCount: 3,
            unknownAuditCount: 2,
            failedAuditCount: 1,
            externalActionCallCount: 8,
            externalPlannerCallCount: 0,
            nonHoldRate: 0.5,
            acceptedRate: 0.75,
            auditedEffectRate: 0.5,
            readyForDeveloperReview: false,
            summary: "Remote Frontier needed contract and loop fixes.",
            topSuggestions: ["Fix parser failures first."],
            iterationCoach: {
              status: "needs_contract_fix",
              priorityFixes: ["Fix parser failures first."],
              exampleTurns: [],
              practicePrompts: [],
            },
          },
          agents: [
            {
              agentID: "remote-frontier",
              username: "Remote Frontier",
              profile: "opportunistic",
              iterationCoach: {
                status: "needs_contract_fix",
                priorityFixes: ["Fix parser failures first."],
              },
              decisionCount: 8,
              acceptedRate: 0.75,
              nonHoldRate: 0.5,
              fallbackCount: 3,
              parserFailureCount: 1,
              repeatedActionKindCount: 5,
              repeatedExactActionCount: 2,
              improvementSuggestions: ["Fix parser failures first."],
              warnings: ["Parser failed once."],
            },
          ],
        }),
      );
      await fs.writeFile(
        path.join(tournamentDir, "tournament-summary.json"),
        JSON.stringify({
          tournamentID: "hub-tournament",
          scenario: "actions",
          brain: "planner",
          runCount: 2,
          acceptedCount: 16,
          rejectedCount: 0,
          fallbackCount: 0,
          parserFailureCount: 0,
          postSpawnNonHoldActionCount: 6,
          auditStats: { confirmed: 10, unknown: 4, failed: 0 },
          leaderboard: [
            {
              agentName: "Iron Coast",
              profile: "defensive",
              totalScore: 72.5,
              objectiveScore: 64,
              acceptedIntentRate: 1,
              nonHoldRate: 0.7,
              auditScore: 0.5,
            },
          ],
          showcase: {
            status: "showcase-ready",
            averageEntertainmentScore: 78,
            bestRunID: "hub-run",
            bestRunReplayPath: "/ai-league-replay/hub-run",
            agents: [
              {
                agentName: "Iron Coast",
                profile: "defensive",
                brainType: "planner",
                personality: "Protect borders and build economy.",
                styleTags: ["defensive", "economy"],
              },
            ],
            highlightReel: [
              "Iron Coast expanded, built defenses, and survived pressure.",
            ],
            watchWarnings: [],
            nextImprovements: ["Run a longer public showcase."],
          },
          completedAt: "2026-05-09T10:05:00.000Z",
        }),
      );
      await fs.writeFile(
        path.join(evaluationDir, "evaluation-summary.json"),
        JSON.stringify({
          evalID: "hub-eval",
          brain: "mock-llm",
          scenario: "actions",
          runCount: 2,
          decisionCount: 16,
          nonHoldRate: 0.5,
          acceptedRate: 1,
          fallbackRate: 0,
          parserFailureRate: 0,
          completedAt: "2026-05-09T10:06:00.000Z",
        }),
      );
      await fs.writeFile(
        path.join(nationsDir, "iron-coast.json"),
        JSON.stringify({
          schemaVersion: 1,
          agentName: "Iron Coast",
          profile: "defensive",
          brainType: "planner",
          plannerExecutorMode: true,
          personality: "Build economy and protect borders.",
          observationPolicy: "default",
          skillPreferences: {
            defense_building: 1,
            economy_building: 0.8,
          },
          provider: { provider: "mock-llm" },
          openFrontier: {
            nationID: "iron-coast",
            createdAt: "2026-05-09T09:58:00.000Z",
          },
        }),
      );
      await fs.writeFile(
        path.join(nationsDir, "remote-frontier.json"),
        JSON.stringify({
          schemaVersion: 1,
          agentName: "Remote Frontier",
          profile: "opportunistic",
          brainType: "external-http",
          plannerExecutorMode: false,
          personality: "External endpoint chooses from offered legal action ids.",
          policyChangelog:
            "Added repetition penalty and safer economy timing before this rerun.",
          observationPolicy: "default",
          skillPreferences: {
            expansion: 1,
            opportunism: 0.8,
          },
          provider: {
            provider: "external-http",
            endpointUrl: "https://agent.example.com/open-frontier/decide",
            timeoutMs: 5000,
          },
          openFrontier: {
            nationID: "remote-frontier",
            createdAt: "2026-05-09T09:59:00.000Z",
          },
        }),
      );

      const model = await loadAgentDemoHubModel({
        runsRootDir,
        tournamentsRootDir,
        evaluationsRootDir,
        nationsDir,
        manifestDir: path.join(process.cwd(), "docs", "ai-league-agent-manifests"),
        rendererBaseUrl: "http://127.0.0.1:9000",
        closedBeta: { enabled: true, label: "Friends and Family Beta" },
        houseAgentBrain: "planner-codex-cli",
        jobs: [
          {
            jobID: "job-1",
            label: "planner demo (actions)",
            request: {
              kind: "demo",
              brain: "planner",
              scenario: "actions",
            },
            status: "completed",
            startedAt: "2026-05-09T09:59:00.000Z",
            completedAt: "2026-05-09T10:01:00.000Z",
            exitCode: 0,
            outputTail: "",
            latestRunID: "hub-run",
          },
        ],
      });
      const html = renderAgentDemoHubHtml(model);
      const publicHtml = renderOpenFrontierPublicHtml(model);
      const agentStartHtml = renderOpenFrontierAgentStartHtml(model);
      const agentStartJson = openFrontierAgentStartJson(model) as {
        startPage?: string;
        protocolSchema?: string;
        agentCardContract?: { endpointUrl?: string };
        healthCheck?: { legalActionIds?: string[] };
        setupPaths?: {
          windowsPowerShell?: string[];
          codexCli?: string;
          claudeCowork?: string;
          openRouter?: string;
          selfTest?: string;
        };
        starterSelfTest?: { command?: string; defaultEndpointUrl?: string };
        importAndRunEndpoint?: { path?: string };
        latestReplay?: string | null;
      };
      const protocolSchema = openFrontierAgentProtocolSchema() as {
        properties?: Record<string, unknown>;
      };
      const adminHtml = renderOpenFrontierAdminHtml({
        hub: model,
        server: {
          betaEnabled: true,
          rendererBaseUrl: "http://127.0.0.1:9000",
          publicReadiness: {
            status: "ready",
            generatedAt: "2026-05-09T10:07:00.000Z",
            mode: "invite-local",
            shareUrl: "http://127.0.0.1:8787/public",
            checks: [
              {
                id: "showcase",
                label: "Agent showcase",
                status: "pass",
                message: "A showcase-ready tournament is available.",
              },
            ],
            nextActions: ["Share the /public URL and invite code with testers."],
          },
          runningJobID: null,
          queuedJobCount: 0,
          maxQueuedJobs: 3,
          rateLimitBucketCount: 2,
          rateLimits: {
            jobs: 12,
            nations: 30,
          },
        },
      });
      const testerDashboardHtml = renderOpenFrontierTesterDashboardHtml({
        hub: model,
        server: {
          betaEnabled: true,
          rendererBaseUrl: "http://127.0.0.1:9000",
          publicReadiness: {
            status: "ready",
            generatedAt: "2026-05-09T10:07:00.000Z",
            mode: "invite-local",
            shareUrl: "http://127.0.0.1:8787/public",
            checks: [
              {
                id: "showcase",
                label: "Agent showcase",
                status: "pass",
                message: "A showcase-ready tournament is available.",
              },
            ],
            nextActions: ["Share the /public URL and invite code with testers."],
          },
          runningJobID: null,
          queuedJobCount: 0,
          maxQueuedJobs: 1,
          rateLimitBucketCount: 2,
          rateLimits: {
            jobs: 12,
            nations: 30,
          },
        },
      });

      expect(model.runs).toHaveLength(2);
      expect(model.tournaments).toHaveLength(1);
      expect(model.evaluations).toHaveLength(1);
      expect(model.savedNations).toHaveLength(2);
      expect(html).toContain("Open Frontier");
      expect(html).toContain("Create AI Nation");
      expect(html).toContain("Run Open Frontier Match");
      expect(html).toContain("Watch rendered gameplay");
      expect(html).toContain("Manifest-defined roster");
      expect(html).toContain("Saved Open Frontier nations");
      expect(html).toContain("Iron Coast");
      expect(html).toContain("Aggressive Expander");
      expect(html).toContain("hub-run");
      expect(html).toContain("/runs/hub-run/visual-report.html");
      expect(html).toContain("/openfront-replay/hub-run");
      expect(html).toContain("hub-tournament");
      expect(html).toContain("/tournaments/hub-tournament/leaderboard.html");
      expect(html).toContain("hub-eval");
      expect(html).toContain("/evaluations/hub-eval/evaluation-report.md");
      expect(html).toContain("job-1");
      expect(html).toContain("/api/jobs");
      expect(html).toContain("/api/nations");
      expect(publicHtml).toContain("Open Frontier");
      expect(publicHtml).toContain("Connect agents. Watch OpenFront unfold.");
      expect(publicHtml).toContain("/agent-start");
      expect(publicHtml).toContain("Agent setup link");
      expect(publicHtml).toContain("A strategy arena for autonomous agents");
      expect(publicHtml).toContain("Trusted technical beta");
      expect(publicHtml).toContain("Latest rendered match");
      expect(publicHtml).toContain("Latest rendered replay");
      expect(publicHtml).toContain("console-primary-grid");
      expect(publicHtml).toContain("Watch latest replay");
      expect(publicHtml).toContain("Agent League Showcase");
      expect(publicHtml).toContain("Watch showcase replay");
      expect(publicHtml).toContain("Open leaderboard");
      expect(publicHtml).toContain("/tournaments/hub-tournament/leaderboard.html");
      expect(publicHtml).toContain("Iron Coast expanded, built defenses");
      expect(publicHtml).toContain("showcase-ready");
      expect(publicHtml).toContain("Friends and Family Beta");
      expect(publicHtml).toContain("C · Connect your agent");
      expect(publicHtml).toContain("Paste your agent's /agent-card.md link.");
      expect(publicHtml).toContain("Copy setup link");
      expect(publicHtml).toContain("hydrateAgentStartUrl");
      expect(publicHtml).toContain("Import Agent Card");
      expect(publicHtml).toContain("Developer resources");
      expect(publicHtml).toContain("First Agent Checklist");
      expect(publicHtml).toContain('data-checklist-step="cardImported"');
      expect(publicHtml).toContain('data-checklist-step="endpointTested"');
      expect(publicHtml).toContain('data-checklist-step="agentSaved"');
      expect(publicHtml).toContain('data-checklist-step="firstMatchRun"');
      expect(publicHtml).toContain('data-checklist-step="feedbackOpened"');
      expect(publicHtml).toContain("open-frontier-first-agent-checklist-v1");
      expect(publicHtml).toContain("markChecklistStep");
      expect(publicHtml).toContain("Latest Agent Feedback");
      expect(publicHtml).toContain("Rerun Saved Roster");
      expect(publicHtml).toContain("agent-feedback-status");
      expect(publicHtml).toContain("Remote Frontier accepted 12/12 decisions");
      expect(publicHtml).toContain("Break repeated low-value action loops");
      expect(publicHtml).toContain("Update the policy to rank safe City or Factory");
      expect(publicHtml).toContain("Before vs After");
      expect(publicHtml).toContain("Compared with previous feedback run");
      expect(publicHtml).toContain("hub-run-before");
      expect(publicHtml).toContain("+25pp");
      expect(publicHtml).toContain("Refresh comparison");
      expect(publicHtml).toContain("refreshFeedback");
      expect(publicHtml).toContain('/public#agent-feedback');
      expect(publicHtml).toContain("Per-Agent History");
      expect(publicHtml).toContain("Remote Frontier");
      expect(publicHtml).toContain("accepted decisions improved");
      expect(publicHtml).toContain("agent-history-table");
      expect(publicHtml).toContain("Policy changelog");
      expect(publicHtml).toContain("Declared policy change");
      expect(publicHtml).toContain(
        "Added repetition penalty and safer economy timing before this rerun.",
      );
      expect(publicHtml).toContain("startSavedRosterMatch");
      expect(publicHtml).toContain("Paste one Agent Card URL");
      expect(publicHtml).toContain("agent-card-form");
      expect(publicHtml).toContain("/api/agent-cards/import");
      expect(publicHtml).toContain("/api/agent-cards/import-and-run");
      expect(publicHtml).toContain("Import & Run Match");
      expect(publicHtml).toContain("Import Only");
      expect(publicHtml).toContain("/examples/external-agent/OPEN_FRONTIER_AGENT_CARD.md");
      expect(publicHtml).toContain("Advanced: paste endpoint manually");
      expect(publicHtml).toContain("/docs/OPEN_FRONTIER_START_HERE.md");
      expect(publicHtml).toContain("/examples/external-agent/README.md");
      expect(publicHtml).toContain("/docs/OPEN_FRONTIER_OPERATOR_RUNBOOK.md");
      expect(publicHtml).toContain("Saved Agents");
      expect(publicHtml).toContain("Save Reference Nation");
      expect(publicHtml).toContain('name="agentMode" value="external-http"');
      expect(publicHtml).toContain("selectedLegalActionId");
      expect(publicHtml).toContain("Copy-paste LLM starter");
      expect(publicHtml).toContain("npm run self-test");
      expect(publicHtml).toContain("Copy starter command");
      expect(publicHtml).toContain("starter-agent-run-command");
      expect(publicHtml).toContain(
        "http://127.0.0.1:7777/agent-card.md",
      );
      expect(publicHtml).toContain("cat &gt; starter-agent.mjs");
      expect(publicHtml).toContain("node starter-agent.mjs");
      expect(publicHtml).toContain("alliance_request");
      expect(publicHtml).toContain("donate_gold");
      expect(publicHtml).toContain("starter-agent-skill");
      expect(publicHtml).toContain("Never emit raw game intents");
      expect(publicHtml).toContain("data-copy-target");
      expect(publicHtml).toContain("copyText");
      expect(publicHtml).toContain("Test Endpoint");
      expect(publicHtml).toContain("Paste a beta-only endpoint token");
      expect(publicHtml).not.toContain("env:OPEN_FRONTIER_AGENT_TOKEN");
      expect(publicHtml).toContain("external-agent-check-output");
      expect(publicHtml).toContain("externalHealthCheckHtml");
      expect(publicHtml).toContain("Raw output");
      expect(publicHtml).toContain("/api/external-agents/check");
      expect(publicHtml).toContain("Agent Card import stopped at endpoint health check.");
      expect(publicHtml).toContain("Endpoint health check:");
      expect(publicHtml).toContain("Run Match");
      expect(publicHtml).toContain("Run Saved-Roster Match");
      expect(publicHtml).toContain("House agents: Codex CLI planner");
      expect(publicHtml).toContain('brain: "planner-codex-cli"');
      expect(publicHtml).toContain("Reference Nation");
      expect(publicHtml).toContain("External");
      expect(publicHtml).toContain("data-delete-nation-id");
      expect(publicHtml).toContain("DELETE");
      expect(publicHtml).toContain('data-delete-nation-name="Iron Coast"');
      expect(publicHtml).toContain("Send Feedback");
      expect(publicHtml).toContain("/api/beta/feedback");
      expect(publicHtml).toContain("Watch rendered replay");
      expect(publicHtml).toContain("Match package");
      expect(publicHtml).toContain("/runs/hub-run/match-package.html");
      expect(publicHtml).toContain("/runs/hub-run/external-agent-feedback.md");
      expect(publicHtml).toContain("data-checklist-feedback-link");
      expect(publicHtml).toContain("decision report");
      expect(publicHtml).toContain("window.location.href = watchUrl");
      expect(publicHtml).toContain("Iron Coast");
      expect(publicHtml).toContain("local planner");
      expect(publicHtml).toContain("/openfront-replay/hub-run");
      expect(publicHtml).not.toContain("decisions.jsonl");
      expect(publicHtml).not.toContain("match-summary.json");
      expect(publicHtml).not.toContain("job.outputTail");
      expect(publicHtml).toContain("publicJobStatusHtml");
      expect(publicHtml).toContain("Completed, but no replay or report artifact was attached.");
      expect(publicHtml).toContain("Replay missing");
      expect(publicHtml).toContain("game-record.json and spectator-replay.json");
      expect(publicHtml).toContain("run-showcase-tournament");
      expect(publicHtml).toContain("timeline");
      expect(publicHtml).toContain("OPEN_FRONTIER_START_HERE.md");
      expect(publicHtml).not.toContain("/admin");
      const publicRoot = parse(publicHtml);
      expect(publicRoot.querySelector("#showcase")).not.toBeNull();
      expect(publicRoot.querySelector("#first-agent-checklist")).not.toBeNull();
      expect(publicRoot.querySelector("#agent-feedback")).not.toBeNull();
      expect(publicRoot.querySelectorAll(".comparison-cell")).toHaveLength(4);
      expect(publicRoot.querySelectorAll(".agent-history-item")).toHaveLength(1);
      expect(publicRoot.querySelector("#external-agent-form")).not.toBeNull();
      expect(publicRoot.querySelector("#agent-card-form")).not.toBeNull();
      expect(publicRoot.querySelector('input[name="cardUrl"]')).not.toBeNull();
      expect(publicRoot.querySelector("#nation-form")).not.toBeNull();
      expect(publicRoot.querySelector("#run-external-match")?.text).toContain(
        "Run Saved-Roster Match",
      );
      expect(publicRoot.querySelector("#starter-agent-run-command")?.text).toContain(
        "node starter-agent.mjs",
      );
      expect(publicRoot.querySelector("#starter-agent-skill")?.text).toContain(
        "Choose exactly one offered LegalAction.id",
      );
      expect(publicRoot.querySelectorAll("[data-copy-target]")).toHaveLength(2);
      expect(publicRoot.querySelectorAll("[data-checklist-step]")).toHaveLength(5);
      expect(publicRoot.querySelectorAll("[data-checklist-feedback-link]").length).toBeGreaterThan(0);
      expect(publicRoot.querySelectorAll("[data-delete-nation-id]")).toHaveLength(2);
      expect(adminHtml).toContain("Open Frontier Admin");
      expect(adminHtml).toContain("Public Readiness");
      expect(adminHtml).toContain("/api/public-readiness");
      expect(adminHtml).toContain("Agent showcase");
      expect(adminHtml).toContain("Saved Entrants");
      expect(adminHtml).toContain("Rate Limits");
      expect(adminHtml).toContain("2");
      expect(adminHtml).toContain("local planner");
      expect(adminHtml).not.toContain(rootDir);
      expect(adminHtml).not.toContain("decisions.jsonl");
      expect(testerDashboardHtml).toContain("Tester Dashboard");
      expect(testerDashboardHtml).toContain("Endpoint Health");
      expect(testerDashboardHtml).toContain("Check Saved External Endpoints");
      expect(testerDashboardHtml).toContain("/api/tester-dashboard/endpoint-health");
      expect(testerDashboardHtml).toContain("/openfront-replay/hub-run");
      expect(testerDashboardHtml).toContain("/runs/hub-run/external-agent-feedback.md");
      expect(testerDashboardHtml).toContain("Remote Frontier");
      expect(testerDashboardHtml).toContain("Queue");
      expect(testerDashboardHtml).not.toContain(rootDir);
      expect(testerDashboardHtml).not.toContain("decisions.jsonl");
      expect(agentStartHtml).toContain(
        "Build an agent endpoint, then import its Agent Card.",
      );
      expect(agentStartHtml).toContain("/agent-start.json");
      expect(agentStartHtml).toContain("/protocol/open-frontier-agent.schema.json");
      expect(agentStartHtml).toContain("POST /api/agent-cards/import-and-run");
      expect(agentStartHtml).toContain("GET /agent-card.md");
      expect(agentStartHtml).toContain("Copy-paste setup paths");
      expect(agentStartHtml).toContain("Codex CLI local");
      expect(agentStartHtml).toContain("Claude/Cowork command");
      expect(agentStartHtml).toContain("Windows PowerShell");
      expect(agentStartHtml).toContain("Prove starter SDK");
      expect(agentStartHtml).toContain("npm run self-test");
      expect(agentStartHtml).toContain("/examples/external-agent/smoke-test.mjs");
      expect(agentStartHtml).toContain("Manual Test Endpoint expects");
      expect(agentStartJson.startPage).toBe("/agent-start");
      expect(agentStartJson.protocolSchema).toBe(
        "/protocol/open-frontier-agent.schema.json",
      );
      expect(agentStartJson.agentCardContract?.endpointUrl).toContain(
        "not /agent-card.md",
      );
      expect(agentStartJson.healthCheck?.legalActionIds).toEqual([
        "health-check:expand",
        "health-check:hold",
      ]);
      expect(agentStartJson.setupPaths?.windowsPowerShell).toContain("npm start");
      expect(agentStartJson.setupPaths?.codexCli).toContain("codex-cli");
      expect(agentStartJson.setupPaths?.claudeCowork).toContain("claude-cowork");
      expect(agentStartJson.setupPaths?.openRouter).toContain("OPENROUTER_API_KEY");
      expect(agentStartJson.setupPaths?.selfTest).toContain("npm run self-test");
      expect(agentStartJson.starterSelfTest?.command).toBe("npm run self-test");
      expect(agentStartJson.starterSelfTest?.defaultEndpointUrl).toBe(
        "http://127.0.0.1:7777/open-frontier/decide",
      );
      expect(agentStartJson.importAndRunEndpoint?.path).toBe(
        "/api/agent-cards/import-and-run",
      );
      expect(agentStartJson.latestReplay).toBe("/openfront-replay/hub-run");
      expect(protocolSchema.properties).toHaveProperty("selectedLegalActionId");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
