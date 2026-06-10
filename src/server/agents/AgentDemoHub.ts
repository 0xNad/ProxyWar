import fs from "fs/promises";
import path from "path";
import {
  AgentDemoRunIndexEntry,
  writeAgentDemoIndex,
} from "./AgentDemoIndexWriter";
import {
  AgentDemoBrain,
  AgentDemoJobRecord,
  proxyWarTesterSavedRosterJobDefaults,
} from "./AgentDemoServerJobs";
import {
  AgentManifest,
  loadAgentManifestsFromDirectory,
} from "./AgentManifest";
import {
  ProxyWarNationEntry,
  listProxyWarNations,
} from "./ProxyWarNationRegistry";
import type { ProxyWarPublicReadinessReport } from "./ProxyWarPublicReadiness";

interface TournamentIndexSummary {
  tournamentID: string;
  scenario?: string;
  brain?: string;
  runCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  fallbackCount?: number;
  parserFailureCount?: number;
  postSpawnNonHoldActionCount?: number;
  auditStats?: { confirmed?: number; unknown?: number; failed?: number };
  leaderboard?: TournamentIndexLeaderboardEntry[];
  showcase?: TournamentIndexShowcaseSummary;
  completedAt?: string;
}

export interface AgentDemoTournamentIndexEntry extends TournamentIndexSummary {
  directory: string;
  summaryPath: string;
  reportPath: string;
  leaderboardPath: string;
  leaderboardHtmlPath: string;
}

interface TournamentIndexLeaderboardEntry {
  agentName?: string;
  profile?: string;
  totalScore?: number;
  objectiveScore?: number;
  acceptedIntentRate?: number;
  nonHoldRate?: number;
  auditScore?: number;
}

interface TournamentIndexShowcaseSummary {
  status?: string;
  averageEntertainmentScore?: number;
  bestRunID?: string | null;
  bestRunReplayPath?: string | null;
  agents?: TournamentIndexShowcaseAgent[];
  highlightReel?: string[];
  watchWarnings?: string[];
  nextImprovements?: string[];
}

interface TournamentIndexShowcaseAgent {
  agentName?: string;
  profile?: string;
  brainType?: string;
  personality?: string;
  styleTags?: string[];
}

interface EvaluationIndexSummary {
  evalID: string;
  brain?: string;
  scenario?: string;
  runCount?: number;
  decisionCount?: number;
  nonHoldRate?: number;
  acceptedRate?: number;
  fallbackRate?: number;
  parserFailureRate?: number;
  providerTimeoutOrErrorCount?: number;
  completedAt?: string;
}

export interface AgentDemoEvaluationIndexEntry extends EvaluationIndexSummary {
  directory: string;
  summaryPath: string;
  reportPath: string;
}

export interface AgentDemoManifestEntry extends AgentManifest {
  fileName?: string;
}

export interface AgentDemoClosedBetaInfo {
  enabled: boolean;
  label: string;
}

export interface AgentDemoHubModel {
  runsRootDir: string;
  tournamentsRootDir: string;
  evaluationsRootDir: string;
  rendererBaseUrl: string;
  closedBeta?: AgentDemoClosedBetaInfo;
  runs: AgentDemoRunIndexEntry[];
  tournaments: AgentDemoTournamentIndexEntry[];
  evaluations: AgentDemoEvaluationIndexEntry[];
  jobs: AgentDemoJobRecord[];
  manifests: AgentDemoManifestEntry[];
  savedNations: ProxyWarNationEntry[];
  houseAgentBrain: AgentDemoBrain;
}

interface PublicTesterEvidenceState {
  agentCardUrl: string | null;
  agentName: string | null;
  agentEndpoint: string | null;
  endpointHealth: string;
  jobStatus: string;
  runID: string | null;
  replayPath: string | null;
  feedbackPath: string | null;
  failureSummary: string | null;
}

export interface ProxyWarAdminModel {
  hub: AgentDemoHubModel;
  server: {
    betaEnabled: boolean;
    rendererBaseUrl: string;
    publicReadiness?: ProxyWarPublicReadinessReport;
    runningJobID: string | null;
    queuedJobCount: number;
    maxQueuedJobs: number;
    rateLimitBucketCount: number;
    rateLimits: Record<string, number>;
  };
}

export type ProxyWarTesterDashboardModel = ProxyWarAdminModel;

export interface LoadAgentDemoHubOptions {
  runsRootDir?: string;
  tournamentsRootDir?: string;
  evaluationsRootDir?: string;
  manifestDir?: string;
  nationsDir?: string;
  rendererBaseUrl?: string;
  jobs?: AgentDemoJobRecord[];
  closedBeta?: AgentDemoClosedBetaInfo;
  houseAgentBrain?: AgentDemoBrain;
  limit?: number;
}

export function renderProxyWarAgentStartHtml(model: AgentDemoHubModel): string {
  const agentCardExample = `---
agentName: Remote Frontier
profile: opportunistic
doctrine: balanced
endpointUrl: https://your-agent.example.com/proxywar/decide
endpointTimeoutMs: 120000
personality: Expands safely, rotates away from stale actions, and attacks weak rivals.
---`;
  const responseExample = `{
  "selectedLegalActionId": "build:Factory:285648",
  "reason": "Factory is a safe economy build after repeated neutral expansion.",
  "confidence": 0.78
}`;
  const bootstrapCommand = `curl -fsSL https://beta.proxywar.xyz/agent-start.sh | bash -s -- --beta-url https://beta.proxywar.xyz --invite-code "<invite-code>" --relay`;
  const safeGithubCommand = `if [ ! -d ProxyWar-starter-agent ]; then
  git clone https://github.com/0xNad/ProxyWar-starter-agent.git
fi
cd ProxyWar-starter-agent
git pull --ff-only
npm install
npm test
bash ./bootstrap.sh --beta-url https://beta.proxywar.xyz --invite-code "<invite-code>" --relay`;
  const claudeLoginCheck = `which claude
claude --version
echo 'Reply with exactly this JSON and nothing else: {"ok":true}' | claude -p --max-turns 1 --disallowedTools "Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch"

# If that says "Not logged in", run:
claude
/login
# Complete the browser login, exit Claude, then rerun the bootstrap.`;
  const codingAgentPrompt = `You are helping me connect a Proxy War external agent.

Work only from a local persistent terminal on my machine or WSL. If this is a short-lived remote sandbox, stop and tell me to run the local terminal path instead.

Read:
- https://beta.proxywar.xyz/agent-start
- https://beta.proxywar.xyz/agent-start.json
- https://github.com/0xNad/ProxyWar-starter-agent

Avoid curl|bash if you cannot inspect the script. Use the auditable GitHub path:
if [ ! -d ProxyWar-starter-agent ]; then git clone https://github.com/0xNad/ProxyWar-starter-agent.git; fi
cd ProxyWar-starter-agent
git pull --ff-only
npm install
npm test

Before running a match, verify one backend works:
- Claude/Cowork: which claude && claude --version && echo 'Reply with exactly this JSON and nothing else: {"ok":true}' | claude -p --max-turns 1 --disallowedTools "Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch"
- Codex CLI: codex --version
- OpenRouter: require OPENROUTER_API_KEY
- Custom command: must print one strict JSON object

Then run:
bash ./bootstrap.sh --beta-url https://beta.proxywar.xyz --invite-code "<invite-code>" --relay

Rules:
- Managed Agent Relay is the default. It is outbound only and is not a network proxy.
- Keep the terminal open until the match completes.
- Do not put tokens or API keys in the Agent Card.
- Decisions must return strict JSON with selectedLegalActionId equal to one offered LegalAction.id. Do not return raw OpenFront/OpenFrontier/OpenFront intents.

Reply with:
Backend:
Self-test:
Match:
Replay:
Feedback:
Notes:`;
  const starterRequirements = `Proxy War agent handoff:

Run this from a local persistent terminal, local coding-agent terminal, or WSL shell that can keep a process alive for the full match. Do not run it inside a short-lived remote sandbox.

Fast human path:
   curl -fsSL <proxywar-origin>/agent-start.sh | bash -s -- --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay

Safer coding-agent path if curl|bash is refused:
   git clone https://github.com/0xNad/ProxyWar-starter-agent.git
   cd ProxyWar-starter-agent
   npm install
   npm test
   bash ./bootstrap.sh --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay

Default path: Managed Agent Relay. Your machine connects outbound to Proxy War; no public local endpoint, tunnel, or inbound port is required. It is not a network proxy.

The bootstrap must finish these checks before you reply:
   - clone or update https://github.com/0xNad/ProxyWar-starter-agent
   - pick a working backend: Codex CLI, Claude/Cowork, custom command, or OpenRouter
   - run relay self-test
   - create a Managed Agent Relay session
   - start the outbound relay worker
   - save the relay-backed agent, queue a winner-required match, and poll for replay/feedback

Reply in this format:
   Connect mode: Managed Agent Relay
   Self-test: relay passed
   Match: completed
   Replay: <url>
   Feedback: <url>
   Notes: any install/login issue that blocked automation

The decision response must be strict JSON:
   {"selectedLegalActionId":"one-offered-legal-action-id","reason":"short reason"}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Agent Start</title>
  <style>
    :root { color-scheme: dark; --bg:#080b10; --surface:#111720; --surface2:#18202b; --line:#2a3442; --text:#edf1f7; --muted:#a4afbf; --amber:#f4a64a; --cyan:#7ad7f0; --good:#7ee0a8; --bad:#ff9b8f; }
    * { box-sizing:border-box; }
    html, body { max-width:100%; overflow-x:hidden; }
    body { margin:0; background:linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px), var(--bg); background-size:48px 48px,48px 48px,auto; color:var(--text); font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing:0; }
    .shell { width:100%; max-width:1120px; margin:0 auto; padding:24px 18px 56px; }
    .shell *, .shell *::before, .shell *::after { min-width:0; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:18px; }
    .brand { display:flex; gap:10px; align-items:center; font-weight:900; }
    .mark { width:34px; height:34px; border:1px solid rgba(231,235,242,.5); display:grid; place-items:center; border-radius:5px; font:800 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    nav, .links, .text-links { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
    a { color:var(--cyan); font-weight:800; text-decoration:none; }
    a:hover { text-decoration:underline; }
    nav a { color:var(--muted); font-size:13px; }
    nav a:hover { color:var(--text); }
    .button, button.copy-button { min-height:40px; display:inline-flex; align-items:center; justify-content:center; padding:10px 14px; border-radius:5px; border:1px solid var(--line); background:var(--surface2); color:var(--text); font:900 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-decoration:none; cursor:pointer; }
    .button.primary, button.copy-button { background:var(--amber); border-color:var(--amber); color:#1a1206; }
    .hero { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr); gap:16px; align-items:start; padding:26px 0 20px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
    .hero-main { padding:8px 0; }
    .contract-panel { background:rgba(17,23,32,.96); border:1px solid var(--line); border-radius:8px; padding:18px; }
    .priority-panel { background:rgba(17,23,32,.94); border:1px solid rgba(122,215,240,.35); border-radius:8px; padding:18px; }
    .priority-panel p { margin-top:0; }
    .quick-paths { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; }
    .path-card { border:1px solid var(--line); border-radius:8px; background:var(--surface); padding:16px; }
    .path-card.recommended { border-color:rgba(126,224,168,.45); background:rgba(126,224,168,.08); }
    .path-card.warning { border-color:rgba(244,166,74,.45); background:rgba(244,166,74,.08); }
    .path-card strong { display:block; color:var(--text); margin-bottom:6px; }
    .notice-list { display:grid; gap:10px; margin:0; padding:0; list-style:none; }
    .notice-list li { margin:0; padding:10px; border:1px solid var(--line); border-radius:6px; background:#0d121a; color:var(--muted); }
    .notice-list b { color:var(--text); }
    .eyebrow { color:var(--amber); font:800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.14em; }
    h1 { margin:12px 0 14px; max-width:820px; font-size:clamp(38px, 6vw, 68px); line-height:.98; letter-spacing:0; }
    h2 { margin:0 0 10px; font-size:24px; letter-spacing:0; }
    h3 { margin:0 0 8px; font-size:16px; letter-spacing:0; }
    p, li, .flow-step span, .endpoint-row span { color:var(--muted); }
    .lede { max-width:760px; margin-bottom:18px; font-size:17px; color:#cbd3df; }
    .primary-actions { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin:20px 0 0; }
    .text-links a { font-size:13px; }
    .flow-strip { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:1px; margin:18px 0 0; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--line); }
    .flow-step { min-height:86px; padding:13px; background:#0d121a; }
    .flow-step b { display:block; margin-bottom:4px; color:var(--text); }
    .endpoint-list { display:grid; gap:10px; margin:14px 0; }
    .endpoint-row { display:grid; grid-template-columns:70px minmax(0, 1fr); gap:10px; align-items:start; padding:11px; border:1px solid var(--line); border-radius:6px; background:#0d121a; }
    .endpoint-row code { color:var(--text); font-weight:900; }
    .method { color:var(--good); font:900 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .health-row { border:1px solid rgba(126,224,168,.28); border-radius:6px; padding:10px; background:rgba(126,224,168,.08); color:var(--good); font-weight:800; }
    .mistake-row { border:1px solid rgba(255,155,143,.28); border-radius:6px; padding:10px; background:rgba(255,155,143,.08); color:#ffd1cb; font-weight:800; }
    .return-checklist { margin-top:12px; border:1px solid rgba(122,215,240,.28); border-radius:6px; padding:12px; background:rgba(122,215,240,.08); }
    .return-checklist strong { display:block; margin-bottom:6px; color:var(--text); }
    .return-checklist ul { margin:0; padding-left:18px; }
    .support-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:12px; }
    .support-card { border:1px solid var(--line); border-radius:8px; background:var(--surface); padding:14px; }
    .support-card strong { display:block; color:var(--text); margin-bottom:5px; }
    .resource-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-top:12px; }
    .resource-grid a { border:1px solid var(--line); border-radius:8px; background:var(--surface2); padding:10px; color:var(--text); }
    .links { margin-top:18px; }
    code, pre { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing:0; }
    code { color:var(--cyan); }
    pre { max-width:100%; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; padding:12px; border:1px solid var(--line); border-radius:8px; background:#05070a; color:#dbe9f8; }
    main { display:grid; gap:14px; margin-top:16px; }
    .two { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    details { background:rgba(17,23,32,.94); border:1px solid var(--line); border-radius:8px; padding:0; }
    summary { min-height:50px; display:flex; align-items:center; padding:14px 16px; cursor:pointer; color:var(--text); font-weight:900; }
    summary:hover { background:rgba(255,255,255,.03); }
    details[open] summary { border-bottom:1px solid var(--line); }
    .details-body { padding:16px; }
    .panel { background:rgba(17,23,32,.94); border:1px solid var(--line); border-radius:8px; padding:18px; }
    .tag { display:inline-flex; align-items:center; min-height:24px; padding:3px 8px; border:1px solid rgba(126,224,168,.36); border-radius:4px; color:var(--good); background:rgba(126,224,168,.1); font:800 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.08em; }
    li { margin:6px 0; }
    .sr-copy { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
    footer { margin-top:22px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
    @media (max-width: 860px) { .hero, .two, .flow-strip, .support-grid, .quick-paths { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } nav { gap:10px; } .button, button.copy-button { width:100%; } .primary-actions { align-items:stretch; flex-direction:column; } .text-links { width:100%; } .endpoint-row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><span class="mark">PW</span><span>Proxy War</span><span class="tag">Agent Start</span></div>
      <nav>
        <a href="/public">Beta console</a>
        <a href="/agent-start.json">Agent-readable JSON</a>
        <a href="/docs/PROXYWAR_EXTERNAL_AGENT_API.md">API docs</a>
      </nav>
    </header>
    <section class="hero">
      <div class="hero-main">
        <div class="eyebrow">Developer handoff</div>
        <h1>Run one bootstrap command. Get a replay.</h1>
        <p class="lede">Proxy War now treats the starter path as an automated preflight, not a documentation exercise. Use a local persistent terminal, local coding-agent terminal, or WSL shell that already has the chosen agent CLI logged in. Short-lived remote sandboxes cannot finish the relay worker, and the default path needs no public local endpoint or tunnel.</p>
        <div class="primary-actions">
          <button class="copy-button" type="button" data-copy-target="agent-prompt">Copy coding-agent prompt</button>
          <button class="button" type="button" data-copy-target="bootstrap-command">Copy bootstrap command</button>
          <div class="text-links">
            <a href="/examples/external-agent/README.md">Starter SDK guide</a>
            <a href="/examples/external-agent/PROXYWAR_AGENT_CARD.md">Agent Card template</a>
            <a href="/public#connect">Import in beta console</a>
          </div>
        </div>
        <pre id="agent-prompt">${escapeHtml(codingAgentPrompt)}</pre>
        <pre id="bootstrap-command">${escapeHtml(bootstrapCommand)}</pre>
        <button class="button" type="button" data-copy-target="starter-requirements">Copy compact handoff prompt</button>
        <pre id="starter-requirements" class="sr-copy">${escapeHtml(starterRequirements)}</pre>
        <div class="flow-strip" aria-label="Proxy War beta flow">
          <div class="flow-step"><b>1. Bootstrap</b><span>The agent runs one command and fixes local CLI login before a match starts.</span></div>
          <div class="flow-step"><b>2. Relay</b><span>The script creates a Managed Agent Relay session and keeps the local worker connected outbound.</span></div>
          <div class="flow-step"><b>3. Play</b><span>With an invite code, it imports the agent, queues a match, and prints replay plus feedback links.</span></div>
        </div>
      </div>
      <aside class="contract-panel">
        <div class="eyebrow">Starter routes</div>
        <div class="endpoint-list">
          <div class="endpoint-row"><span class="method">GET</span><div><code>/health</code><br><span>Liveness and protocol metadata.</span></div></div>
          <div class="endpoint-row"><span class="method">GET</span><div><code>/agent-card.md</code><br><span>Public import card. No secrets or bearer tokens.</span></div></div>
          <div class="endpoint-row"><span class="method">POST</span><div><code>/proxywar/decide</code><br><span>Decision endpoint referenced by <code>endpointUrl</code>.</span></div></div>
        </div>
        <div class="health-row">Endpoint health passes only when the response contains <code>selectedLegalActionId</code> matching one offered id.</div>
        <p class="mistake-row">Do not paste <code>/proxywar/decide</code> into the Agent Card field. Paste <code>/agent-card.md</code>; the card contains <code>endpointUrl</code>.</p>
        <div class="return-checklist">
          <strong>Before you reply to the tester</strong>
          <ul>
            <li>Run the default <code>--relay</code> bootstrap first.</li>
            <li>Return replay and feedback links when the match completes.</li>
            <li>Use public Agent Card mode only when the tester explicitly chooses advanced HTTP setup.</li>
          </ul>
        </div>
      </aside>
    </section>
    <main>
      <section class="priority-panel">
        <div class="eyebrow">Recommended tester handoff</div>
        <h2>Give agents the auditable path first</h2>
        <p>Some coding agents correctly refuse opaque <code>curl | bash</code>. Send them this page, then ask them to clone the public starter repo, inspect the script, run the self-test, and launch the managed relay. This still ends in the same automated match and replay.</p>
        <div class="two">
          <div>
            <h3>Safer GitHub path</h3>
            <pre id="safe-github-command">${escapeHtml(safeGithubCommand)}</pre>
            <button class="button" type="button" data-copy-target="safe-github-command">Copy GitHub setup</button>
          </div>
          <div>
            <h3>Claude/Cowork login check</h3>
            <pre>${escapeHtml(claudeLoginCheck)}</pre>
            <p>If this fails, run the interactive Claude login in the same shell first. On Windows, use the WSL shell where <code>claude -p</code> works.</p>
          </div>
        </div>
      </section>
      <section class="quick-paths" aria-label="Choose a setup path">
        <article class="path-card recommended">
          <strong>Best for testers: Local terminal or local coding agent</strong>
          <p>Run Managed Agent Relay from a terminal that stays open. The worker polls outbound and posts decisions back; it is not a network proxy.</p>
          <p><b>Keep this terminal open</b> until the match prints replay and feedback links.</p>
        </article>
        <article class="path-card">
          <strong>Best for cautious coding agents: GitHub starter</strong>
          <p>Clone <code>0xNad/ProxyWar-starter-agent</code>, inspect <code>bootstrap.sh</code>, run <code>npm test</code>, then run the same relay bootstrap from the checked-out repo.</p>
          <p>This avoids asking the agent to execute a script it cannot inspect.</p>
        </article>
        <article class="path-card warning">
          <strong>Not supported: short-lived remote sandbox</strong>
          <p>Do not run this inside a short-lived remote sandbox that kills background processes or lacks your logged-in Claude/Codex CLI. It will pass setup and then lose the relay worker during the match.</p>
        </article>
      </section>
      <section class="panel">
        <h2>Preflight checklist</h2>
        <ul class="notice-list">
          <li><b>Runtime:</b> Node.js 20+, npm, git, and curl are available in the same shell.</li>
          <li><b>Backend:</b> Codex CLI, Claude/Cowork, OpenRouter, or a custom command can run non-interactively and print strict JSON.</li>
          <li><b>Safety:</b> Managed Relay opens no inbound port. Advanced HTTP Agent Card mode is the only path that exposes an endpoint.</li>
          <li><b>Contract:</b> Every decision must return <code>selectedLegalActionId</code> equal to one offered <code>LegalAction.id</code>.</li>
        </ul>
      </section>
      <details open>
        <summary>Copy-paste setup paths</summary>
        <div class="details-body support-grid">
          <div class="support-card"><strong>Safer GitHub path</strong><pre>git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
npm install
npm test
bash ./bootstrap.sh --beta-url https://beta.proxywar.xyz --invite-code "&lt;invite-code&gt;" --relay</pre><span>Use this when a coding agent refuses <code>curl | bash</code>. The script is inside the public repo and can be inspected before it runs.</span></div>
          <div class="support-card"><strong>One-command bootstrap</strong><pre>curl -fsSL https://beta.proxywar.xyz/agent-start.sh | bash -s -- --beta-url https://beta.proxywar.xyz --invite-code "&lt;invite-code&gt;" --relay</pre><span>Uses Codex CLI, Claude/Cowork, a custom command, or OpenRouter, then connects through Managed Agent Relay and queues a match.</span></div>
          <div class="support-card"><strong>Codex CLI local</strong><pre>git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
cp .env.example .env
./launch.sh codex-cli</pre><span>Uses your local Codex CLI login; no model API key goes into an Agent Card.</span></div>
          <div class="support-card"><strong>Claude/Cowork command</strong><pre>git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
cp .env.example .env
./launch.sh claude-cowork</pre><span>Use <code>./launch.sh command "your-cowork-command --print-json"</code> if your Cowork command differs. Do not source <code>.env</code>.</span></div>
          <div class="support-card"><strong>Windows PowerShell</strong><pre>git clone https://github.com/0xNad/ProxyWar-starter-agent.git
cd ProxyWar-starter-agent
copy .env.example .env
$env:PROXYWAR_AGENT_LLM_PROVIDER="codex-cli"
npm install
npm start</pre></div>
          <div class="support-card"><strong>Prove starter SDK</strong><pre># ./launch.sh runs this automatically.
# If you started with npm start, run this in a second terminal.
npm run self-test</pre><span>Self-test posts the health-check contract to <code>/proxywar/decide</code>. Fix this before importing or saving the agent.</span></div>
          <div class="support-card"><strong>OpenRouter fallback</strong><pre>cp .env.example .env
PROXYWAR_AGENT_LLM_PROVIDER=openrouter \
OPENROUTER_API_KEY="paste-your-openrouter-key" \
npm start</pre><span>Only this path needs a model API key.</span></div>
          <div class="support-card"><strong>Remote HTTPS</strong><pre>export PROXYWAR_AGENT_PUBLIC_URL="https://your-agent.example.com"
export PROXYWAR_AGENT_ENDPOINT_TOKEN="make-a-random-beta-token"
npm start</pre><span>Paste <code>https://your-agent.example.com/agent-card.md</code> into Connect With One Link, and paste the token into the endpoint token field. Manual Test Endpoint expects <code>https://your-agent.example.com/proxywar/decide</code>.</span></div>
        </div>
      </details>
      <details>
        <summary>Contract examples and common fixes</summary>
        <div class="details-body">
          <div class="two">
            <article>
              <h2>Agent Card example</h2>
              <pre>${escapeHtml(agentCardExample)}</pre>
            </article>
            <article>
              <h2>Decision response example</h2>
              <pre>${escapeHtml(responseExample)}</pre>
              <p>Unknown ids, raw intents, code, prose-only responses, and malformed JSON are rejected or recorded as failures.</p>
            </article>
          </div>
          <div class="support-grid">
            <div class="support-card"><strong>If health returns <code>actionId</code></strong><span>Rename it to <code>selectedLegalActionId</code>. The value must exactly match one offered legal action id.</span></div>
            <div class="support-card"><strong>If import rejects localhost</strong><span>Shared beta endpoints must be public HTTPS. Localhost is only for local development.</span></div>
            <div class="support-card"><strong>If the endpoint times out</strong><span>Reduce model/tool work or return a simple legal action first, then improve the policy after the first replay.</span></div>
          </div>
        </div>
      </details>
      <details>
        <summary>Resources and authenticated import endpoint</summary>
        <div class="details-body">
          <div class="resource-grid">
            <a href="/examples/external-agent/simple-agent.mjs">simple-agent.mjs</a>
            <a href="/examples/external-agent/smoke-test.mjs">smoke-test.mjs</a>
            <a href="/examples/external-agent/starter-framework.mjs">starter-framework.mjs</a>
            <a href="/examples/external-agent/PROXYWAR_AGENT_CARD.md">Agent Card template</a>
            <a href="https://github.com/0xNad/ProxyWar-starter-agent" target="_blank" rel="noopener noreferrer">GitHub starter template</a>
            <a href="/docs/PROXYWAR_EXTERNAL_AGENT_API.md">Full API docs</a>
            <a href="/docs/PROXYWAR_TESTER_HANDOFF.md">Tester handoff</a>
            <a href="/protocol/proxywar-agent.schema.json">Protocol schema</a>
          </div>
          <p>Windows note: the starter is source code for Node.js, not a double-clickable app. Download the GitHub template ZIP or clone the repo, extract it, open PowerShell inside the folder, then run <code>npm install</code> and <code>npm start</code>.</p>
          <h2>Authenticated import-and-run endpoint</h2>
          <p>After beta login, an agent/browser session can submit:</p>
          <pre>POST /api/agent-cards/import-and-run
{
  "cardUrl": "https://your-agent.example.com/agent-card.md",
  "endpointToken": "optional beta-only bearer token"
}</pre>
          <p>The server performs the same Agent Card import, endpoint policy, roster sync, queue limits, and job lifecycle as the normal UI. It returns a job id; poll <code>/api/jobs/&lt;jobID&gt;</code> for the replay URL.</p>
        </div>
      </details>
    </main>
    <footer>Proxy War external agents use the same LegalAction.id contract as house agents. Core simulation remains deterministic.</footer>
  </div>
  <script>
    document.querySelectorAll("[data-copy-target]").forEach((button) => {
      const defaultText = button.textContent || "Copy";
      button.addEventListener("click", async () => {
        const target = document.getElementById(button.getAttribute("data-copy-target") || "");
        const text = target ? target.textContent || "" : "";
        try {
          await navigator.clipboard.writeText(text.trim());
          button.textContent = "Copied";
          window.setTimeout(() => { button.textContent = defaultText; }, 1400);
        } catch (_error) {
          button.textContent = "Copy failed";
          window.setTimeout(() => { button.textContent = defaultText; }, 1400);
        }
      });
    });
    const bootstrapCommand = document.getElementById("bootstrap-command");
    if (bootstrapCommand) {
      const origin = window.location.origin || "https://beta.proxywar.xyz";
      bootstrapCommand.textContent = "curl -fsSL " + origin + "/agent-start.sh | bash -s -- --beta-url " + origin + " --invite-code \\"<invite-code>\\" --relay";
      const agentPrompt = document.getElementById("agent-prompt");
      if (agentPrompt) agentPrompt.textContent = (agentPrompt.textContent || "").replaceAll("https://beta.proxywar.xyz", origin);
      const safeGithubCommand = document.getElementById("safe-github-command");
      if (safeGithubCommand) safeGithubCommand.textContent = (safeGithubCommand.textContent || "").replaceAll("https://beta.proxywar.xyz", origin);
    }
  </script>
</body>
</html>`;
}

export function proxyWarAgentStartJson(model: AgentDemoHubModel): unknown {
  const latestRun = featuredRenderedRun(model.runs);
  return {
    product: "Proxy War",
    audience: "AI hobbyists and developers connecting autonomous agents",
    goal: "Connect a local starter, run the locked saved-agent plus one-Codex-agent beta match against two Easy built-in nations, and return rendered replay plus feedback.",
    startPage: "/agent-start",
    oneCommandBootstrap: {
      script: "/agent-start.sh",
      publicScript: "/examples/external-agent/bootstrap.sh",
      defaultCommand:
        'curl -fsSL <proxywar-origin>/agent-start.sh | bash -s -- --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay',
      importAndRunCommand:
        'curl -fsSL <proxywar-origin>/agent-start.sh | bash -s -- --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay',
      does: [
        "clone or fast-forward the public starter repo",
        "choose a working Codex CLI, Claude/Cowork, custom command, or OpenRouter backend",
        "run relay self-test before creating a beta session",
        "create a Managed Agent Relay session",
        "start the outbound relay worker with a short-lived session token",
        "save the relay-backed agent, queue a winner-required match, and print replay plus feedback links",
      ],
      sourceTransparency:
        "If a coding agent refuses curl|bash, clone https://github.com/0xNad/ProxyWar-starter-agent, inspect bootstrap.sh, run npm test, then run bash ./bootstrap.sh with the same beta URL, invite code, and --relay flag.",
      security:
        "Default relay mode requires no inbound local endpoint or tunnel. The short-lived relay token is returned only to the bootstrap worker and stored server-side as a secret reference.",
    },
    testerRequirements: {
      environment:
        "Use a local persistent terminal, local coding-agent terminal, or WSL shell that can keep the relay worker running until the match completes.",
      notSupported:
        "Short-lived remote sandboxes that kill background processes or lack the user's logged-in Claude/Codex CLI cannot complete a relay match.",
      backend:
        "At least one backend must be installed, logged in, and non-interactive: Codex CLI, Claude/Cowork, OpenRouter, or a custom command.",
      claudeCheck:
        "which claude && claude --version && echo 'Reply with exactly this JSON and nothing else: {\"ok\":true}' | claude -p --max-turns 1 --disallowedTools \"Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch\"",
      claudeLogin:
        "Run claude, type /login, complete the browser login, exit Claude, then rerun the bootstrap from the same shell or WSL environment.",
      relaySafety:
        "Managed Agent Relay uses outbound polling only and is not a network proxy. It does not expose an inbound local endpoint.",
    },
    protocolSchema: "/protocol/proxywar-agent.schema.json",
    starterSdk: {
      readme: "/examples/external-agent/README.md",
      server: "/examples/external-agent/simple-agent.mjs",
      selfTest: "/examples/external-agent/smoke-test.mjs",
      framework: "/examples/external-agent/starter-framework.mjs",
      bootstrap: "/examples/external-agent/bootstrap.sh",
      relayWorker: "/examples/external-agent/relay-worker.mjs",
      skill: "/examples/external-agent/AGENT_SKILL.md",
      cardTemplate: "/examples/external-agent/PROXYWAR_AGENT_CARD.md",
    },
    requiredEndpoints: [
      {
        method: "GET",
        path: "/health",
        purpose: "liveness and protocol metadata",
      },
      {
        method: "GET",
        path: "/agent-card.md",
        purpose:
          "public import card; contains endpointUrl but never secrets or bearer tokens",
      },
      {
        method: "POST",
        path: "/proxywar/decide",
        purpose: "select one offered LegalAction.id",
      },
    ],
    agentCardContract: {
      requiredFrontmatter: ["agentName", "profile", "endpointUrl"],
      recommendedFrontmatter: [
        "doctrine",
        "endpointTimeoutMs",
        "personality",
        "policyChangelog",
      ],
      endpointUrl:
        "decision POST URL, usually https://host/proxywar/decide; not /agent-card.md and not /health",
      secrets:
        "do not put bearer tokens, API keys, env refs, or secret refs in the card",
    },
    setupPaths: {
      oneCommand:
        'curl -fsSL <proxywar-origin>/agent-start.sh | bash -s -- --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay',
      oneCommandImportAndRun:
        'curl -fsSL <proxywar-origin>/agent-start.sh | bash -s -- --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay',
      saferGitHubClone: [
        "git clone https://github.com/0xNad/ProxyWar-starter-agent.git",
        "cd ProxyWar-starter-agent",
        "npm install",
        "npm test",
        'bash ./bootstrap.sh --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay',
      ],
      macLinux:
        "git clone https://github.com/0xNad/ProxyWar-starter-agent.git && cd ProxyWar-starter-agent && cp .env.example .env && ./launch.sh codex-cli",
      codexCli: "./launch.sh codex-cli",
      claudeCowork: "./launch.sh claude-cowork",
      claudeLoginCheck: [
        "which claude",
        "claude --version",
        "echo 'Reply with exactly this JSON and nothing else: {\"ok\":true}' | claude -p --max-turns 1 --disallowedTools \"Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch\"",
        "claude",
        "/login",
      ],
      customCommand: './launch.sh command "your-cowork-command --print-json"',
      openRouter:
        'PROXYWAR_AGENT_LLM_PROVIDER=openrouter OPENROUTER_API_KEY="paste-your-openrouter-key" ./launch.sh openrouter',
      windowsPowerShell: [
        "git clone https://github.com/0xNad/ProxyWar-starter-agent.git",
        "cd ProxyWar-starter-agent",
        "copy .env.example .env",
        '$env:PROXYWAR_AGENT_LLM_PROVIDER="codex-cli"',
        "npm install",
        "npm start",
      ],
      selfTest:
        "./launch.sh runs npm run self-test automatically; if using npm start manually, run npm run self-test in a second terminal before sharing /agent-card.md",
      remoteHttps:
        'export PROXYWAR_AGENT_PUBLIC_URL="https://your-agent.example.com" and PROXYWAR_AGENT_ENDPOINT_TOKEN="make-a-random-beta-token", run npm start, then paste https://your-agent.example.com/agent-card.md into Connect With One Link and paste the token into the endpoint token field',
      endpointToken:
        "Optional but recommended for public starter endpoints: set PROXYWAR_AGENT_ENDPOINT_TOKEN and paste the same beta-only token into Proxy War's endpoint token field. Never put tokens in /agent-card.md.",
    },
    copyPasteAgentPrompt:
      'Clone https://github.com/0xNad/ProxyWar-starter-agent, inspect bootstrap.sh, run npm install and npm test, verify a local non-interactive backend, then run bash ./bootstrap.sh --beta-url <proxywar-origin> --invite-code "<invite-code>" --relay. Use a local persistent terminal or WSL shell only; stop if this is a short-lived remote sandbox.',
    starterSelfTest: {
      command: "npm run self-test",
      defaultEndpointUrl: "http://127.0.0.1:7777/proxywar/decide",
      overrideEndpointEnv: "PROXYWAR_AGENT_TEST_ENDPOINT_URL",
      passesWhen:
        "the running starter returns strict JSON with selectedLegalActionId equal to health-check:expand or health-check:hold",
      runBefore: "publishing or returning the public /agent-card.md URL",
      commonFailures: [
        "server is not running",
        "LLM provider is not configured",
        "Codex CLI or Claude/Cowork command is not installed or logged in",
        ".env was sourced by bash instead of parsed by the Node starter",
        "OpenRouter provider is selected without OPENROUTER_API_KEY",
        "endpoint returned actionId, markdown, raw game-engine intent JSON, or an unknown id",
      ],
    },
    healthCheck: {
      uiButton: "Test Endpoint",
      method: "POST",
      path: "/proxywar/decide",
      legalActionIds: ["health-check:expand", "health-check:hold"],
      passesWhen:
        "response is strict JSON selecting one of those ids with selectedLegalActionId",
      commonFailures: [
        "returned actionId instead of selectedLegalActionId",
        "pasted /agent-card.md into the manual endpoint field",
        "returned raw game-engine intent JSON",
        "used localhost against a remote beta host",
        "timed out before returning strict JSON",
      ],
    },
    decisionContract: {
      input: ["AgentObservation", "LegalAction[]"],
      output: {
        selectedLegalActionId: "string; must exactly match an offered id",
        reason: "short human-readable string",
        confidence: "optional number from 0 to 1",
      },
      forbidden: [
        "raw game intents",
        "invented action ids",
        "tool calls",
        "code output",
        "freeform prose without JSON",
      ],
    },
    managedRelay: {
      default: true,
      sessionEndpoint: "/api/agent-relay/sessions",
      workerPollEndpoint: "/api/agent-relay/sessions/{sessionID}/poll",
      workerDecisionEndpoint: "/api/agent-relay/sessions/{sessionID}/decisions",
      internalRequestEndpoint: "/api/agent-relay/sessions/{sessionID}/requests",
      transport:
        "The local starter polls outbound for canonical Proxy War decision requests and posts selectedLegalActionId responses back. It does not expose an inbound endpoint.",
    },
    betaConsole: "/public",
    importAndRunEndpoint: {
      method: "POST",
      path: "/api/agent-cards/import-and-run",
      auth: "requires beta session",
      body: {
        cardUrl: "https://your-agent.example.com/agent-card.md",
        endpointToken: "optional beta-only bearer token",
      },
      response: {
        jobID: "poll /api/jobs/{jobID}",
        replayUrl: "present when job completes",
      },
    },
    latestReplay:
      latestRun !== null && latestRun.hasOpenFrontReplay
        ? `/proxywar-replay/${latestRun.runID}`
        : null,
  };
}

export function proxyWarAgentProtocolSchema(): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Proxy War external agent decision response",
    type: "object",
    additionalProperties: false,
    required: ["selectedLegalActionId", "reason"],
    properties: {
      selectedLegalActionId: {
        type: "string",
        minLength: 1,
        description: "Must exactly match one offered LegalAction.id.",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: 500,
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
    },
  };
}

const starterAgentSkillPrompt = `You control one Proxy War nation.

Return strict JSON only:
{
  "selectedLegalActionId": "exact-offered-id",
  "reason": "Short factual reason tied to observed state.",
  "confidence": 0.7
}

Rules:
- Choose exactly one offered LegalAction.id.
- Never invent ids.
- Never emit raw game intents.
- Never write code, prose, tool calls, or extra JSON fields.
- Choose hold only when no useful safe action is available.

Strategy:
1. Expand into neutral land early while troop reserves are safe, but do not tunnel on expansion forever.
2. Build City or Factory when stable and economy can grow, especially after several successful expansions.
3. Build Defense Posts only near real borders or threats.
4. Attack weak bordered rivals when risk is favorable.
5. Use alliance_request to reduce threat or create useful buffers.
6. Use donate_gold or donate_troops only when an ally is useful and the cost is safe.
7. Use embargoes as pressure, not as a permanent substitute for attacking.
8. Avoid repeated low-value actions.
9. Preserve enough troops to survive counterattacks.
10. Finish weakened rivals instead of stalling.
11. If the last 3 post-spawn actions were the same kind and a different useful non-hold action is legal, rotate.
12. Choose hold only when every non-hold action is unsafe, stale, or strategically irrelevant.`;

const starterAgentServerCode = `import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const host = process.env.PROXYWAR_AGENT_HOST ?? "127.0.0.1";
const port = Number(process.env.PROXYWAR_AGENT_PORT ?? process.env.PORT ?? 7777);
const decisionPath = process.env.PROXYWAR_AGENT_ENDPOINT_PATH ?? "/proxywar/decide";
const cardPath = process.env.PROXYWAR_AGENT_CARD_PATH ?? "/agent-card.md";
const apiKey = process.env.OPENROUTER_API_KEY;
const llmProvider = normalizeLlmProvider(process.env.PROXYWAR_AGENT_LLM_PROVIDER);
const model = process.env.OPENROUTER_MODEL ?? process.env.PROXYWAR_AGENT_LLM_MODEL ?? "google/gemini-2.5-flash-lite";
const skillPrompt = ${JSON.stringify(starterAgentSkillPrompt)};

if (!llmProvider && !apiKey && !process.env.PROXYWAR_AGENT_LLM_COMMAND) {
  console.error("Configure PROXYWAR_AGENT_LLM_PROVIDER=codex-cli, claude-cowork, command, or openrouter. The starter never makes policy-only gameplay decisions.");
  process.exit(1);
}

http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://" + (request.headers.host ?? "127.0.0.1:7777"));

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    const publicBaseUrl = process.env.PROXYWAR_AGENT_PUBLIC_URL ?? publicBaseUrlFromRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      protocolVersion: "proxywar-agent-v1",
      decisionPath,
      cardPath,
      decisionEndpointUrl: new URL(decisionPath, publicBaseUrl).toString(),
      agentCardUrl: new URL(cardPath, publicBaseUrl).toString(),
      agentName: process.env.PROXYWAR_AGENT_NAME ?? "Starter Frontier",
      healthCheck: {
        method: "POST",
        path: decisionPath,
        legalActionIds: ["health-check:expand", "health-check:hold"]
      },
      llmProvider: describeLlmProvider(),
      responseContract: {
        selectedLegalActionId: "must exactly match one offered legalActions[].id",
        reason: "short human-readable string",
        confidence: "optional number from 0 to 1"
      },
      forbidden: ["raw game intents", "invented ids", "actionId alias"]
    }));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === cardPath) {
    response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    response.end(createAgentCardMarkdown(request));
    return;
  }

  if (request.method !== "POST" || requestUrl.pathname !== decisionPath) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    const payload = JSON.parse(await readBody(request));
    const legalActions = Array.isArray(payload.legalActions)
      ? payload.legalActions
      : [];
    if (legalActions.length === 0) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "no legal actions offered" }));
      return;
    }

    const prompt = buildPrompt(payload, legalActions);
    const first = parseDecision(await complete(prompt), legalActions);
    let decision;
    if (first.ok) {
      decision = first.value;
    } else {
      const repaired = parseDecision(
        await complete(prompt + "\\nPrevious response was invalid: " + first.error + "\\nReturn corrected JSON only."),
        legalActions,
      );
      if (!repaired.ok) throw new Error(repaired.error);
      decision = repaired.value;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(decision));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}).listen(port, host, () => {
  console.log("Proxy War LLM starter agent listening at http://" + host + ":" + port + decisionPath);
  console.log("Agent Card: http://" + host + ":" + port + cardPath);
  console.log("LLM brain: " + describeLlmProvider().label);
});

function createAgentCardMarkdown(request) {
  const publicBaseUrl = process.env.PROXYWAR_AGENT_PUBLIC_URL ?? publicBaseUrlFromRequest(request);
  const endpointUrl = new URL(decisionPath, publicBaseUrl).toString();
  const agentName = cleanFrontmatter(process.env.PROXYWAR_AGENT_NAME ?? "Starter Frontier");
  const profile = normalizeProfile(process.env.PROXYWAR_AGENT_PROFILE ?? "opportunistic");
  const doctrine = cleanFrontmatter(process.env.PROXYWAR_AGENT_DOCTRINE ?? "balanced");
  const personality = cleanFrontmatter(process.env.PROXYWAR_AGENT_PERSONALITY ?? "LLM-backed starter agent that selects one offered LegalAction.id.");
  const timeoutMs = Number(process.env.PROXYWAR_AGENT_ENDPOINT_TIMEOUT_MS ?? 120000);
  return [
    "---",
    "agentName: " + agentName,
    "profile: " + profile,
    "doctrine: " + doctrine,
    "endpointUrl: " + endpointUrl,
  "endpointTimeoutMs: " + (Number.isFinite(timeoutMs) ? Math.max(250, Math.min(180000, Math.round(timeoutMs))) : 120000),
    "personality: " + personality,
    "---",
    "",
    "# " + agentName,
    "",
    "LLM-backed Proxy War external agent. It chooses exactly one offered LegalAction.id and never emits raw intents.",
    ""
  ].join("\\n");
}

function publicBaseUrlFromRequest(request) {
  const hostHeader = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const protocol = forwardedProto || (hostHeader.startsWith("127.0.0.1") || hostHeader.startsWith("localhost") ? "http" : "https");
  return hostHeader ? protocol + "://" + hostHeader : "http://127.0.0.1:7777";
}

function normalizeProfile(value) {
  return ["aggressive", "defensive", "diplomatic", "opportunistic"].includes(String(value))
    ? String(value)
    : "opportunistic";
}

function cleanFrontmatter(value) {
  return String(value ?? "").replace(/[\\r\\n:]/g, " ").replace(/\\s+/g, " ").trim().slice(0, 240);
}

function buildPrompt(payload, legalActions) {
  const compactActions = legalActions.slice(0, 30).map((action) => ({
    id: action.id,
    kind: action.kind,
    label: action.label,
    risk: action.risk,
    metadata: action.metadata
  }));
  return [
    skillPrompt,
    "Runtime contract: choose exactly one listed LegalAction.id. Do not write code. Do not invent actions.",
    "Agent:",
    JSON.stringify(payload.agent ?? {}, null, 2),
    "Observation:",
    JSON.stringify(payload.observation ?? {}, null, 2).slice(0, 6000),
    "Legal actions:",
    JSON.stringify(compactActions, null, 2),
  ].join("\\n");
}

async function complete(prompt) {
  if (llmProvider === "codex-cli") {
    return completeCommand(
      process.env.CODEX_COMMAND ?? "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--output-last-message",
        "{{outputFile}}",
        "-"
      ],
      prompt
    );
  }
  if (llmProvider === "claude-cowork" || llmProvider === "claude-cli") {
    if (process.env.PROXYWAR_AGENT_LLM_COMMAND) {
      return completeCommandFromEnv(prompt);
    }
    return completeCommand(process.env.CLAUDE_COMMAND ?? "claude", defaultClaudeCommandArgs(), prompt);
  }
  if (llmProvider === "command" || process.env.PROXYWAR_AGENT_LLM_COMMAND) {
    return completeCommandFromEnv(prompt);
  }
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required when PROXYWAR_AGENT_LLM_PROVIDER=openrouter.");
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
      "http-referer": "http://127.0.0.1:8787",
      "x-title": "Proxy War Starter Agent"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: 'Return strict JSON only: {"selectedLegalActionId":"exact offered id","reason":"short reason","confidence":0.7}'
        },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 220,
      response_format: { type: "json_object" }
    })
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error("OpenRouter " + response.status + ": " + JSON.stringify(json).slice(0, 240));
  }
  return String(json.choices?.[0]?.message?.content ?? "");
}

function completeCommandFromEnv(prompt) {
  const commandSpec = process.env.PROXYWAR_AGENT_LLM_COMMAND;
  if (!commandSpec) {
    throw new Error("PROXYWAR_AGENT_LLM_COMMAND is required for command-backed providers.");
  }
  const parts = splitCommandLine(commandSpec);
  const args = splitCommandLine(process.env.PROXYWAR_AGENT_LLM_ARGS ?? "");
  return completeCommand(parts[0], parts.slice(1).concat(args), prompt);
}

function defaultClaudeCommandArgs() {
  return [
    "-p",
    "--max-turns",
    "1",
    "--disallowedTools",
    "Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch"
  ];
}

function completeCommand(command, args, prompt) {
  const timeoutMs = Math.max(1000, Math.min(600000, Number(process.env.PROXYWAR_AGENT_LLM_TIMEOUT_MS ?? 12000)));
  const prepared = prepareCommandArgs(args, prompt);
  return new Promise((resolve, reject) => {
    const child = spawn(command, prepared.args, {
      cwd: process.env.PROXYWAR_AGENT_LLM_CWD ?? process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", (error) => {
      clearTimeout(timer);
      cleanupTempFile(prepared.promptFilePath);
      cleanupTempFile(prepared.outputFilePath);
      reject(new Error("Could not start LLM command " + command + ": " + (error instanceof Error ? error.message : String(error))));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let finalOutput = "";
      if (prepared.outputFilePath) {
        try {
          finalOutput = fs.readFileSync(prepared.outputFilePath, "utf8");
        } catch {}
      }
      cleanupTempFile(prepared.promptFilePath);
      cleanupTempFile(prepared.outputFilePath);
      if (code !== 0) {
        reject(new Error("LLM command exited with " + (signal ?? code) + ": " + (stderr.trim() || stdout.trim() || "no output").slice(0, 500)));
        return;
      }
      resolve((finalOutput.trim() || stdout.trim()).trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prepared.stdinPrompt);
  });
}

function prepareCommandArgs(args, prompt) {
  let usesPromptPlaceholder = false;
  let promptFilePath = null;
  let outputFilePath = null;
  return {
    args: args.map((arg) => {
      let value = arg;
      if (value.includes("{{prompt}}")) {
        usesPromptPlaceholder = true;
        value = value.replaceAll("{{prompt}}", prompt);
      }
      if (value.includes("{{promptFile}}")) {
        usesPromptPlaceholder = true;
        promptFilePath ??= writeTempFile("proxywar-prompt", prompt);
        value = value.replaceAll("{{promptFile}}", promptFilePath);
      }
      if (value.includes("{{outputFile}}")) {
        outputFilePath ??= tempFilePath("proxywar-output");
        value = value.replaceAll("{{outputFile}}", outputFilePath);
      }
      return value;
    }),
    stdinPrompt: usesPromptPlaceholder ? "" : prompt,
    promptFilePath,
    outputFilePath
  };
}

function tempFilePath(prefix) {
  return path.join(os.tmpdir(), prefix + "-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".txt");
}

function writeTempFile(prefix, text) {
  const file = tempFilePath(prefix);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

function cleanupTempFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {}
}

function splitCommandLine(input) {
  const result = [];
  let current = "";
  let quote = null;
  const text = String(input ?? "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\\\") {
      const next = text[index + 1];
      if (next !== undefined && (next === "\\\\" || next === '"' || next === "'" || /\\s/.test(next))) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) result.push(current);
  return result;
}

function normalizeLlmProvider(value) {
  const provider = String(value ?? "").trim().toLowerCase();
  if (!provider && process.env.PROXYWAR_AGENT_LLM_COMMAND) return "command";
  if (!provider && apiKey) return "openrouter";
  if (["codex", "codex-cli", "codex_cli"].includes(provider)) return "codex-cli";
  if (["claude", "claude-cli", "claude_cli"].includes(provider)) return "claude-cli";
  if (["claude-cowork", "claude_cowork", "cowork", "cowork-cli", "cowork_cli"].includes(provider)) return "claude-cowork";
  if (["command", "cli", "local-command", "local_cli"].includes(provider)) return "command";
  if (["openrouter", "open-router"].includes(provider)) return "openrouter";
  return provider;
}

function describeLlmProvider() {
  if (llmProvider === "codex-cli") return { provider: "codex-cli", mode: "local-cli", label: "Codex CLI", secretRequired: false };
  if (llmProvider === "claude-cowork") return { provider: "claude-cowork", mode: "local-cli", label: "Claude/Cowork command", secretRequired: false };
  if (llmProvider === "claude-cli") return { provider: "claude-cli", mode: "local-cli", label: "Claude CLI", secretRequired: false };
  if (llmProvider === "command") return { provider: "command", mode: "local-command", label: "Custom local command", secretRequired: false };
  return { provider: "openrouter", mode: "api", label: "OpenRouter", secretRequired: true };
}

function parseDecision(raw, legalActions) {
  const cleaned = String(raw).trim();
  if (/^\\\`\\\`\\\`(?:json)?\\s*[\\s\\S]*\\\`\\\`\\\`$/i.test(cleaned)) {
    return { ok: false, error: "markdown code fence is not allowed; return the JSON object only" };
  }
  if (!cleaned.startsWith("{")) {
    return { ok: false, error: "response must be strict JSON only, with no prose or logs before the object" };
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return { ok: false, error: "invalid JSON: " + (error instanceof Error ? error.message : String(error)) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "LLM response must be a JSON object" };
  }
  const allowedKeys = new Set(["selectedLegalActionId", "reason", "confidence"]);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      if (key === "actionId") {
        return { ok: false, error: "unknown JSON field: actionId. Use selectedLegalActionId instead." };
      }
      return { ok: false, error: "unknown JSON field: " + key };
    }
  }
  const id = parsed.selectedLegalActionId;
  const action = legalActions.find((candidate) => candidate.id === id);
  if (typeof id !== "string" || !action) {
    return { ok: false, error: "unknown selectedLegalActionId " + JSON.stringify(id) + "; choose one of: " + legalActions.slice(0, 8).map((candidate) => candidate.id).join(", ") };
  }
  const reason = typeof parsed.reason === "string" && parsed.reason.trim()
    ? parsed.reason.trim()
    : "";
  if (!reason) {
    return { ok: false, error: "reason cannot be empty" };
  }
  const confidence = Number.isFinite(Number(parsed.confidence))
    ? Number(parsed.confidence)
    : 0.6;
  if (confidence < 0 || confidence > 1) {
    return { ok: false, error: "confidence must be between 0 and 1" };
  }
  return {
    ok: true,
    value: {
      selectedLegalActionId: action.id,
      reason: reason.slice(0, 240),
      confidence
    }
  };
}

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 128 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}`;

const starterAgentRunCommand = `cat > starter-agent.mjs <<'EOF'
${starterAgentServerCode}
EOF
PROXYWAR_AGENT_LLM_PROVIDER=codex-cli node starter-agent.mjs
# Or:
# PROXYWAR_AGENT_LLM_PROVIDER=claude-cowork PROXYWAR_AGENT_LLM_COMMAND='claude -p --max-turns 1 --disallowedTools "Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch"' node starter-agent.mjs
# PROXYWAR_AGENT_LLM_PROVIDER=openrouter OPENROUTER_API_KEY="paste-your-openrouter-key" node starter-agent.mjs`;

export async function loadAgentDemoHubModel(
  options: LoadAgentDemoHubOptions = {},
): Promise<AgentDemoHubModel> {
  const runsRootDir =
    options.runsRootDir ??
    path.join(process.cwd(), "artifacts", "ai-league-runs");
  const tournamentsRootDir =
    options.tournamentsRootDir ??
    path.join(process.cwd(), "artifacts", "ai-league-tournaments");
  const evaluationsRootDir =
    options.evaluationsRootDir ??
    path.join(process.cwd(), "artifacts", "ai-league-evals");
  const manifestDir =
    options.manifestDir ??
    path.join(process.cwd(), "docs", "ai-league-agent-manifests");
  const nationsDir =
    options.nationsDir ??
    path.join(process.cwd(), "artifacts", "proxywar", "nations");
  const { runs } = await writeAgentDemoIndex({
    runsRootDir,
    limit: options.limit ?? 50,
  });
  const tournaments = await discoverTournaments(
    tournamentsRootDir,
    options.limit ?? 30,
  );
  const evaluations = await discoverEvaluations(
    evaluationsRootDir,
    options.limit ?? 30,
  );
  return {
    runsRootDir,
    tournamentsRootDir,
    evaluationsRootDir,
    rendererBaseUrl: options.rendererBaseUrl ?? "http://127.0.0.1:9000",
    closedBeta: options.closedBeta,
    runs,
    tournaments,
    evaluations,
    jobs: (options.jobs ?? []).slice(0, options.limit ?? 50),
    manifests: await discoverManifests(manifestDir),
    savedNations: await listProxyWarNations(nationsDir),
    houseAgentBrain: options.houseAgentBrain ?? "planner-codex-cli",
  };
}

export function renderAgentDemoHubHtml(model: AgentDemoHubModel): string {
  const runRows = model.runs.map((run) => runRow(run)).join("\n");
  const tournamentRows = model.tournaments
    .map((tournament) => tournamentRow(tournament))
    .join("\n");
  const evaluationRows = model.evaluations
    .map((evaluation) => evaluationRow(evaluation))
    .join("\n");
  const jobRows = model.jobs.map((job) => jobRow(job)).join("\n");
  const manifestCards = model.manifests
    .map((manifest) => manifestCard(manifest))
    .join("\n");
  const savedNationCards = model.savedNations
    .map((nation) => savedNationCard(nation))
    .join("\n");
  const latestRun = featuredRenderedRun(model.runs);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Demo</title>
  <style>
    :root { color-scheme: light; --ink:#16202d; --muted:#607086; --line:#d9e1ec; --paper:#f5f7fb; --panel:#fff; --accent:#1d5e8f; --accent-2:#1f7a55; --bad:#a32438; --warn:#8a5c05; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { background:linear-gradient(135deg, #102236, #234b5d 55%, #256255); color:white; padding:34px 36px 28px; }
    header h1 { margin:0; font-size:32px; letter-spacing:0; }
    header p { margin:8px 0 0; max-width:780px; color:#dce9f0; }
    main { max-width:1440px; margin:0 auto; padding:24px 32px 48px; }
    h2 { margin:0 0 12px; font-size:20px; }
    h3 { margin:0 0 8px; font-size:16px; }
    a { color:var(--accent); font-weight:700; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break:break-word; }
    .grid { display:grid; grid-template-columns:minmax(320px, 430px) 1fr; gap:18px; align-items:start; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; box-shadow:0 8px 24px rgba(20, 35, 54, .06); }
    .hint { color:var(--muted); font-size:13px; }
    .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:18px; }
    .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    .stat span { display:block; color:var(--muted); font-size:12px; }
    .stat strong { display:block; font-size:24px; margin-top:4px; }
    label { display:block; color:#405166; font-weight:700; font-size:12px; margin:10px 0 5px; }
    select, input { width:100%; border:1px solid #cbd6e2; border-radius:6px; padding:9px 10px; background:white; color:var(--ink); font:inherit; }
    button { width:100%; border:0; border-radius:6px; padding:10px 12px; margin-top:14px; background:var(--accent); color:white; font:700 14px/1.2 inherit; cursor:pointer; }
    button.secondary { background:var(--accent-2); }
    button:disabled { opacity:.55; cursor:wait; }
    table { width:100%; border-collapse:collapse; background:white; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#eef3f8; color:#46576c; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    tr:last-child td { border-bottom:0; }
    .links { display:flex; flex-wrap:wrap; gap:9px; }
    .pill { display:inline-flex; align-items:center; min-height:22px; padding:2px 8px; border-radius:999px; background:#edf4fb; color:#315474; font-weight:700; font-size:12px; }
    .pill.good { background:#e7f5ee; color:var(--accent-2); }
    .pill.bad { background:#fdebf0; color:var(--bad); }
    .pill.warn { background:#fff6dc; color:var(--warn); }
    .empty { color:var(--muted); padding:18px; border:1px dashed var(--line); border-radius:8px; background:white; }
    .job-log { white-space:pre-wrap; max-height:360px; overflow:auto; background:#111b29; color:#d7e6f6; border-radius:8px; padding:12px; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .manifest-grid { display:grid; gap:8px; margin-top:10px; }
    .manifest-card { border:1px solid var(--line); border-radius:8px; padding:10px; background:#f9fbfd; }
    .manifest-card strong { display:block; }
    .manifest-card p { margin:4px 0 0; color:var(--muted); font-size:12px; }
    .section { margin-top:18px; }
    @media (max-width: 980px) { .grid { grid-template-columns:1fr; } main { padding:18px; } header { padding:28px 20px; } }
  </style>
</head>
<body>
  <header>
    <h1>Proxy War</h1>
    <p>Create AI nations, enter them into autonomous strategy matches, and watch them expand, ally, fight, or collapse.</p>
  </header>
  <main>
    <section class="stat-grid">
      <div class="stat"><span>Recent Runs</span><strong>${model.runs.length}</strong></div>
      <div class="stat"><span>Accepted Decisions</span><strong>${sum(model.runs, "acceptedCount")}</strong></div>
      <div class="stat"><span>Post-spawn Non-hold</span><strong>${sum(model.runs, "postSpawnNonHoldActionCount")}</strong></div>
      <div class="stat"><span>Tournaments</span><strong>${model.tournaments.length}</strong></div>
    </section>
    ${
      latestRun
        ? `<section class="panel" style="margin-bottom:18px">
            <h2>Latest Rendered Match</h2>
            <p><code>${escapeHtml(latestRun.runID)}</code></p>
            <div class="links">
              ${latestRun.hasOpenFrontReplay ? `<a href="/proxywar-replay/${encodeURIComponent(latestRun.runID)}" target="_blank">Watch rendered gameplay</a>` : ""}
              ${latestRun.hasMatchPackage ? `<a href="/runs/${encodeURIComponent(latestRun.runID)}/${latestRun.matchPackageLinkFileName}">Match package</a>` : ""}
              <a href="/runs/${encodeURIComponent(latestRun.runID)}/visual-report.html">Decision report</a>
              ${latestRun.hasSpectatorReplay ? `<a href="/runs/${encodeURIComponent(latestRun.runID)}/spectator.html">Watch artifact replay</a>` : ""}
              <a href="/runs/${encodeURIComponent(latestRun.runID)}/match-report.md">Read match report</a>
            </div>
          </section>`
        : ""
    }
    <section class="grid">
      <aside class="panel">
        <h2>Run A Match</h2>
        <p class="hint">Starts the locked beta match: the latest saved tester agent plus one Codex agent against two Easy built-in nations until a winner emerges.</p>
        <form id="demo-form">
          <input type="hidden" name="kind" value="demo">
          <input type="hidden" name="agents" value="1">
          <input type="hidden" name="nations" value="2">
          <input type="hidden" name="difficulty" value="Easy">
          <label for="brain">Brain</label>
          <select id="brain" name="brain">
            <option value="codex-cli"${selectedAttribute(model.houseAgentBrain, "codex-cli")}>Codex CLI direct decisions</option>
            <option value="planner-codex-cli"${selectedAttribute(model.houseAgentBrain, "planner-codex-cli")}>Codex CLI planner</option>
          </select>
          <label for="scenario">Scenario</label>
          <select id="scenario" name="scenario">
            <option value="actions">Normal actions</option>
            <option value="normal">League default</option>
            <option value="attack">Deterministic attack</option>
            <option value="stepped">Stepped default</option>
          </select>
          <label for="roster">Agent roster</label>
          <select id="roster" name="roster">
            <option value="default">Default four profiles</option>
            <option value="manifest">Manifest-defined roster</option>
            <option value="saved">Saved Proxy War nations</option>
          </select>
          <p class="hint">Saved rosters use your created nations plus curated defaults until there are at least four entrants.</p>
          ${
            model.savedNations.length === 0
              ? '<p class="hint">No saved Proxy War nations yet.</p>'
              : `<div class="manifest-grid">${savedNationCards}</div>`
          }
          ${
            model.manifests.length === 0
              ? '<p class="hint">No manifest roster files were found.</p>'
              : `<div class="manifest-grid">${manifestCards}</div>`
          }
          <label for="maxSteps">Decision-step fail-safe</label>
          <input id="maxSteps" name="maxSteps" type="number" min="1" max="1000" value="700">
          <p class="hint">One round freezes the match, lets each AI observe and act, then advances the game. More rounds means a longer watchable match.</p>
          <input type="hidden" name="matchLength" value="full">
          <label for="bots">Built-in bots</label>
          <input id="bots" name="bots" type="number" min="0" max="12" value="0">
          <button type="submit">Run Proxy War Match</button>
        </form>
        <form id="nation-form" class="section">
          <h3>Create AI Nation</h3>
          <p class="hint">Manifest-only nations are safe configs: name, doctrine, profile, and skill preferences. No user code runs on the server.</p>
          <label for="agentName">Nation name</label>
          <input id="agentName" name="agentName" type="text" maxlength="60" value="Iron Coast">
          <label for="profile">Profile</label>
          <select id="profile" name="profile">
            <option value="aggressive">Aggressive</option>
            <option value="defensive">Defensive</option>
            <option value="diplomatic">Diplomatic</option>
            <option value="opportunistic">Opportunistic</option>
          </select>
          <label for="doctrine">Doctrine</label>
          <select id="doctrine" name="doctrine">
            <option value="balanced">Balanced</option>
            <option value="economic">Economic growth</option>
            <option value="fortress">Fortress defense</option>
            <option value="diplomatic">Alliance network</option>
            <option value="pressure">Pressure rivals</option>
          </select>
          <label for="personality">Doctrine note</label>
          <input id="personality" name="personality" type="text" maxlength="240" value="Build a strong economy, avoid bad wars, and expand when the border is safe.">
          <button class="secondary" type="submit">Save AI Nation</button>
        </form>
        <form id="eval-form" class="section">
          <input type="hidden" name="kind" value="evaluation">
          <input type="hidden" name="brain" value="mock-llm">
          <input type="hidden" name="scenario" value="actions">
          <input type="hidden" name="runs" value="2">
          <h3>Quick Evaluation</h3>
          <p class="hint">Runs two mock action matches and writes an evaluation report.</p>
          <button class="secondary" type="submit">Run Mock Evaluation</button>
        </form>
        <form id="tournament-form" class="section">
          <input type="hidden" name="kind" value="tournament">
          <input type="hidden" name="brain" value="planner">
          <input type="hidden" name="scenario" value="actions">
          <input type="hidden" name="runs" value="2">
          <h3>Quick Tournament</h3>
          <p class="hint">Runs the manifest-defined planner tournament.</p>
          <button class="secondary" type="submit">Run Planner Tournament</button>
        </form>
        <div class="section">
          <h3>Renderer</h3>
          <p class="hint">Native Proxy War replay route: <a href="${escapeAttribute(model.rendererBaseUrl)}" target="_blank">${escapeHtml(model.rendererBaseUrl)}</a>. Start this hub with the default renderer option, or run the renderer script separately if needed.</p>
          ${
            latestRun?.hasOpenFrontReplay
              ? `<p><a href="/proxywar-replay/${encodeURIComponent(latestRun.runID)}" target="_blank">Open latest run in native renderer</a></p>`
              : ""
          }
        </div>
      </aside>
      <section class="panel">
        <h2>Job Output</h2>
        <p class="hint">Started jobs and nation creation results appear here. Refresh after a job finishes to see new artifacts in the tables.</p>
        <pre id="job-output" class="job-log">No job running.</pre>
      </section>
    </section>
    <section class="section">
      <h2>Recent Jobs</h2>
      ${
        model.jobs.length === 0
          ? '<div class="empty">No demo-server jobs have been recorded yet.</div>'
          : `<table>
              <thead>
                <tr>
                  <th>Job</th><th>Status</th><th>Started</th><th>Completed</th><th>Latest Artifact</th><th>Error</th>
                </tr>
              </thead>
              <tbody>${jobRows}</tbody>
            </table>`
      }
    </section>
    <section class="section">
      <h2>Recent Match Runs</h2>
      ${
        model.runs.length === 0
          ? '<div class="empty">No Proxy War match artifacts found yet.</div>'
          : `<table>
              <thead>
                <tr>
                  <th>Run</th><th>Brain</th><th>Scenario</th><th>Mode</th>
                  <th>Decisions</th><th>Non-hold</th><th>Accepted</th><th>Parser/Fallback</th><th>Audit</th><th>Links</th>
                </tr>
              </thead>
              <tbody>${runRows}</tbody>
            </table>`
      }
    </section>
    <section class="section">
      <h2>Tournaments</h2>
      ${
        model.tournaments.length === 0
          ? '<div class="empty">No tournament artifacts found yet.</div>'
          : `<table>
              <thead>
                <tr>
                  <th>Tournament</th><th>Brain</th><th>Scenario</th><th>Runs</th>
                  <th>Non-hold</th><th>Accepted</th><th>Parser/Fallback</th><th>Audit</th><th>Links</th>
                </tr>
              </thead>
              <tbody>${tournamentRows}</tbody>
            </table>`
      }
    </section>
    <section class="section">
      <h2>Evaluations</h2>
      ${
        model.evaluations.length === 0
          ? '<div class="empty">No evaluation artifacts found yet.</div>'
          : `<table>
              <thead>
                <tr>
                  <th>Evaluation</th><th>Brain</th><th>Scenario</th><th>Runs</th><th>Decisions</th><th>Rates</th><th>Links</th>
                </tr>
              </thead>
              <tbody>${evaluationRows}</tbody>
            </table>`
      }
    </section>
  </main>
  <script>
    const output = document.getElementById("job-output");
    for (const form of [document.getElementById("demo-form"), document.getElementById("nation-form"), document.getElementById("eval-form"), document.getElementById("tournament-form")]) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        output.textContent = "Starting job...";
        try {
          const body = Object.fromEntries(new FormData(form).entries());
          const endpoint = form.id === "nation-form" ? "/api/nations" : "/api/jobs";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const created = await response.json();
          if (!response.ok) throw new Error(created.error ?? "request failed");
          if (endpoint === "/api/nations") {
            output.textContent = "Saved nation: " + created.nation.agentName + "\\nActive roster size: " + created.activeRosterCount + "\\nRefresh to see it in Saved Proxy War nations.";
          } else {
            await pollJob(created.jobID);
          }
        } catch (error) {
          output.textContent = String(error);
        } finally {
          button.disabled = false;
        }
      });
    }
    async function pollJob(jobID) {
      while (true) {
        const response = await fetch("/api/jobs/" + encodeURIComponent(jobID));
        const job = await response.json();
        output.textContent = [
          "Job: " + job.label,
          "Status: " + job.status,
          "Started: " + job.startedAt,
          job.completedAt ? "Completed: " + job.completedAt : "",
          "",
          job.outputTail ?? ""
        ].filter(Boolean).join("\\n");
        if (job.status === "completed" || job.status === "failed") return;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  </script>
</body>
</html>`;
}

export function renderProxyWarPublicHtml(model: AgentDemoHubModel): string {
  const latestRun = featuredRenderedRun(model.runs);
  const latestTournament = featuredShowcaseTournament(model.tournaments);
  const activeJob =
    model.jobs.find(
      (job) => job.status === "running" || job.status === "queued",
    ) ?? null;
  const savedCards = model.savedNations
    .map((nation) => sleekSavedNationCard(nation))
    .join("\n");
  const externalAgentCount = model.savedNations.filter(
    (nation) => nation.provider?.provider === "external-http",
  ).length;
  const recentRows = model.runs
    .slice(0, 8)
    .map((run) => sleekPublicRunRow(run))
    .join("\n");
  const showcaseLeaderboardRows =
    latestTournament?.leaderboard
      ?.slice(0, 4)
      .map((agent, index) => publicTournamentLeaderboardRow(agent, index))
      .join("\n") ?? "";
  const showcaseAgentCards =
    latestTournament?.showcase?.agents
      ?.slice(0, 4)
      .map((agent) => publicTournamentAgentCard(agent))
      .join("\n") ?? "";
  const showcaseHighlights =
    latestTournament?.showcase?.highlightReel
      ?.slice(0, 5)
      .map((highlight) => `<li>${escapeHtml(highlight)}</li>`)
      .join("\n") ?? "";
  const latestReplayLink =
    latestRun !== null && latestRun.hasOpenFrontReplay
      ? `/proxywar-replay/${encodeURIComponent(latestRun.runID)}`
      : null;
  const feedbackRuns = model.runs.filter(
    (run) => run.externalFeedbackPreview !== undefined,
  );
  const latestFeedbackRun = feedbackRuns[0] ?? latestRun;
  const previousFeedbackRun =
    latestFeedbackRun === null
      ? null
      : (feedbackRuns.find((run) => run.runID !== latestFeedbackRun.runID) ??
        null);
  const latestTournamentReplayLink = latestTournament
    ? publicTournamentBestReplayLink(latestTournament)
    : null;
  const latestFeedbackLink =
    latestFeedbackRun !== null && latestFeedbackRun.hasExternalFeedback
      ? `/runs/${encodeURIComponent(latestFeedbackRun.runID)}/external-agent-feedback.md`
      : null;
  const latestExternalAgent =
    model.savedNations.find(
      (nation) => nation.provider?.provider === "external-http",
    ) ?? null;
  const latestEvidenceAgent = latestExternalAgent;
  const latestEvidenceEndpoint =
    latestExternalAgent?.provider?.provider === "external-http"
      ? latestExternalAgent.provider.endpointUrl
      : null;
  const latestFailedJob =
    latestRun === null
      ? (model.jobs.find((job) => job.status === "failed") ?? null)
      : null;
  const initialTesterEvidenceState: PublicTesterEvidenceState = {
    agentCardUrl: null,
    agentName: latestEvidenceAgent?.agentName ?? null,
    agentEndpoint: latestEvidenceEndpoint,
    endpointHealth: "not checked in this browser session",
    jobStatus: activeJob ? `${activeJob.status} (${activeJob.jobID})` : "idle",
    runID: latestRun?.runID ?? null,
    replayPath:
      latestRun?.hasOpenFrontReplay === true
        ? `/proxywar-replay/${encodeURIComponent(latestRun.runID)}`
        : null,
    feedbackPath: latestFeedbackLink,
    failureSummary: latestFailedJob?.errorSummary ?? null,
  };
  const initialTesterEvidencePacket = publicTesterEvidencePacketText(
    initialTesterEvidenceState,
  );
  const latestFeedbackPreviewVisible =
    latestFeedbackRun?.externalFeedbackPreview !== undefined;
  const firstAgentChecklistServerState = {
    cardImported: externalAgentCount > 0,
    endpointTested: false,
    agentSaved: externalAgentCount > 0,
    firstMatchRun:
      latestRun?.hasOpenFrontReplay === true ||
      latestRun?.hasMatchPackage === true ||
      latestRun?.hasSpectatorReplay === true,
    feedbackAvailable: latestFeedbackRun?.hasExternalFeedback === true,
    feedbackOpened: latestFeedbackPreviewVisible,
  };
  const houseAgentBrainLabel =
    model.houseAgentBrain === "planner-codex-cli"
      ? "Codex CLI planner"
      : model.houseAgentBrain === "codex-cli"
        ? "Codex CLI direct decisions"
        : "LLM-backed house agent";
  const publicCodexMatchRequestJson = JSON.stringify({
    ...proxyWarTesterSavedRosterJobDefaults,
    brain: model.houseAgentBrain,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War</title>
  <style>
    :root { color-scheme: light; --ink:#18212d; --muted:#657386; --line:#d9e1e8; --paper:#f6f8f5; --panel:#fff; --soft:#f8fbf8; --accent:#176358; --accent-2:#263f57; --warn:#94640f; --bad:#a43b4b; --good:#1f744e; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body::before { content:""; position:fixed; inset:0 0 auto; height:360px; pointer-events:none; background:linear-gradient(180deg, rgba(23,99,88,.12), transparent); }
    a { color:var(--accent); font-weight:800; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .shell { position:relative; width:min(1180px, calc(100% - 32px)); margin:0 auto; padding:22px 0 56px; }
    .topbar { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:26px; }
    .brand { display:flex; align-items:center; gap:10px; font-weight:950; letter-spacing:0; }
    .brand-mark { width:34px; height:34px; display:grid; place-items:center; border-radius:8px; background:var(--accent-2); color:#fff; }
    nav { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    nav a { min-height:34px; display:inline-flex; align-items:center; padding:7px 10px; border:1px solid var(--line); border-radius:7px; background:#fff; color:#2b4b61; }
    .hero { display:grid; grid-template-columns:minmax(0, 1.15fr) minmax(320px, .85fr); gap:16px; align-items:stretch; margin-bottom:16px; }
    .card, .hero-copy, .hero-status { background:rgba(255,255,255,.96); border:1px solid var(--line); border-radius:10px; box-shadow:0 16px 42px rgba(28,43,58,.07); }
    .hero-copy { padding:30px; min-height:340px; display:flex; flex-direction:column; justify-content:space-between; }
    .eyebrow { color:var(--accent); font-size:12px; font-weight:950; letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin:10px 0 14px; font-size:clamp(42px, 6.5vw, 76px); line-height:.95; letter-spacing:0; }
    h2 { margin:0 0 10px; font-size:24px; letter-spacing:0; }
    h3 { margin:0 0 6px; font-size:17px; letter-spacing:0; }
    p { margin:0; }
    .hint { color:var(--muted); font-size:13px; }
    .lede { max-width:720px; color:#536174; font-size:18px; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:24px; }
    .hero-action-row { align-items:center; }
    .hero-text-links { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
    .hero-text-links a { font-size:13px; }
    .button, button { min-height:40px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:10px 13px; border-radius:7px; border:1px solid transparent; background:var(--accent); color:#fff; font:850 14px/1.1 inherit; cursor:pointer; text-decoration:none; }
    .button.secondary, button.secondary { background:#fff; color:#29455d; border-color:var(--line); }
    .button.ghost, button.ghost { background:#eff6f3; color:#155a52; border-color:#bdd7ce; }
    .button.danger, button.danger { background:#fff0f2; color:var(--bad); border-color:#efc6cf; }
    button:disabled { opacity:.58; cursor:wait; }
    .hero-status { padding:18px; display:grid; gap:12px; }
    .metric-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
    .metric { border:1px solid #e2e8ee; background:var(--soft); border-radius:8px; padding:12px; }
    .metric span { display:block; color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.05em; }
    .metric strong { display:block; font-size:26px; margin-top:2px; }
    .showcase-grid { display:grid; grid-template-columns:minmax(0, 1fr) minmax(300px, .75fr); gap:16px; align-items:start; }
    .showcase-stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; margin:12px 0; }
    .showcase-stat { border:1px solid #e0e8ee; background:var(--soft); border-radius:8px; padding:10px; }
    .showcase-stat span { display:block; color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; }
    .showcase-stat strong { display:block; font-size:22px; margin-top:2px; }
    .highlight-list { margin:12px 0 0; padding-left:18px; color:#405166; }
    .highlight-list li { margin:5px 0; }
    main { display:grid; gap:16px; }
    .card { padding:18px; }
    .section-head { display:flex; justify-content:space-between; align-items:start; gap:14px; margin-bottom:14px; }
    .two-col { display:grid; grid-template-columns:minmax(320px, 420px) 1fr; gap:16px; align-items:start; }
    label { display:block; margin:10px 0 5px; color:#405166; font-weight:850; font-size:12px; }
    input, select, textarea { width:100%; border:1px solid #cbd6e2; border-radius:7px; padding:10px; background:#fff; color:var(--ink); font:inherit; }
    textarea { min-height:86px; resize:vertical; }
    .inline-actions { display:flex; flex-wrap:wrap; gap:9px; margin-top:12px; }
    .inline-actions button, .inline-actions .button { width:auto; margin:0; }
    .callout { border:1px solid #d4e5de; background:#f5fbf8; border-radius:9px; padding:13px; }
    .prompt-line { display:inline-flex; max-width:100%; margin-top:18px; padding:10px 12px; border:1px solid #d5e2dc; border-radius:8px; background:#f7fbf8; color:#29455d; font:13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow:auto; }
    .step-strip { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:8px; margin:18px 0 0; }
    .step-strip span { border:1px solid #dbe6e0; border-radius:8px; background:#fbfdfb; padding:10px; color:#405166; font-size:12px; font-weight:850; }
    .checklist-card { display:grid; gap:14px; }
    .checklist-progress { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .checklist-steps { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:8px; }
    .checklist-steps li { min-height:150px; border:1px solid #dbe6e0; border-radius:9px; background:#fbfdfb; padding:12px; display:grid; grid-template-rows:auto 1fr auto; gap:8px; }
    .checklist-steps li.current { border-color:#86b9ad; box-shadow:0 0 0 2px rgba(23,99,88,.10); }
    .checklist-steps li.done { background:#f1faf5; border-color:#b7d9c7; }
    .check-index { width:28px; height:28px; display:grid; place-items:center; border-radius:999px; background:#e8f4ef; color:var(--accent); font-weight:950; }
    .check-state { justify-self:start; min-height:22px; display:inline-flex; align-items:center; padding:2px 8px; border-radius:999px; background:#eef2f6; color:#526274; font-size:12px; font-weight:850; }
    .check-state.current { background:#fff6dc; color:var(--warn); }
    .check-state.done { background:#e2f5ea; color:var(--good); }
    .checklist-links { margin-top:0; }
    .feedback-card { display:grid; gap:14px; }
    .feedback-layout { display:grid; grid-template-columns:minmax(0, 1fr) minmax(260px, .58fr); gap:14px; align-items:start; }
    .feedback-summary { display:grid; gap:12px; }
    .feedback-metrics { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:8px; }
    .feedback-metric { border:1px solid #dfe9e4; border-radius:8px; background:#fbfdfb; padding:10px; }
    .feedback-metric span { display:block; color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; }
    .feedback-metric strong { display:block; margin-top:2px; font-size:21px; }
    .feedback-block { border:1px solid #dfe7ed; border-radius:9px; background:#fbfcfb; padding:12px; }
      .feedback-block + .feedback-block { margin-top:10px; }
      .feedback-list { margin:8px 0 0; padding-left:20px; color:#34475d; }
      .feedback-list li { margin:5px 0; }
      .comparison-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px; }
      .comparison-cell { border:1px solid #dfe7ed; border-radius:8px; background:#fbfdfb; padding:10px; display:grid; gap:4px; }
      .comparison-cell span { color:var(--muted); font-size:11px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; }
      .comparison-cell strong { font-size:18px; }
      .delta { font-weight:900; font-size:12px; }
      .delta.good { color:var(--good); }
      .delta.bad { color:var(--bad); }
      .delta.flat { color:var(--muted); }
      .agent-history-list { display:grid; gap:14px; margin-top:10px; }
      .agent-history-item { border-top:1px solid #dfe7ed; padding-top:12px; display:grid; gap:10px; }
      .agent-history-head { display:flex; justify-content:space-between; align-items:start; gap:12px; flex-wrap:wrap; }
      .agent-history-metrics { display:grid; grid-template-columns:repeat(auto-fit, minmax(115px, 1fr)); gap:8px; }
      .agent-history-metric { border:1px solid #e1e9ef; border-radius:8px; background:#fff; padding:9px; }
      .agent-history-metric span { display:block; color:var(--muted); font-size:10px; font-weight:850; text-transform:uppercase; letter-spacing:.04em; }
      .agent-history-metric strong { display:block; margin-top:2px; font-size:18px; }
      .agent-history-table-wrap { overflow:auto; border:1px solid #e1e9ef; border-radius:8px; background:#fff; }
      .agent-history-table { min-width:620px; border:0; }
      .agent-history-table th, .agent-history-table td { padding:8px 9px; font-size:12px; }
      .policy-change-note { border:1px solid #d6e7df; background:#f6fbf8; border-radius:8px; padding:10px; color:#29455d; }
      .example-turn { display:grid; gap:7px; color:#34475d; font-size:13px; }
    .practice-prompt { margin-top:8px; border:1px solid #dae5df; border-radius:8px; padding:10px; background:#f7fbf8; color:#29455d; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .primary-connect { border:1px solid #d2e5db; border-radius:10px; background:linear-gradient(180deg, #fbfffd, #f4faf7); padding:14px; }
    .agent-start-copy { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:12px; align-items:center; margin:0 0 12px; padding:13px; border:1px solid #d6e7df; border-radius:10px; background:#f7fbf8; }
    .agent-start-copy code { display:inline-block; margin-top:6px; color:var(--accent); font-weight:900; }
    .agent-card-import { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:10px; align-items:end; margin:14px 0 10px; }
    .agent-card-import button { margin:0; white-space:nowrap; }
    .token-field { grid-column:1 / -1; margin-top:0; }
    .token-field input { margin-top:8px; }
    .advanced-connect { margin-top:12px; }
    .advanced-connect > summary { min-height:40px; display:flex; align-items:center; }
    .advanced-connect .two-col { margin-top:12px; }
    .status-box { min-height:72px; margin-top:12px; padding:12px; border:1px solid #ccd9e6; border-radius:9px; background:#f5f9ff; color:#29455d; white-space:pre-wrap; }
    .status-box strong { display:block; margin-bottom:4px; }
    .roster-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px; }
    .agent-card { border:1px solid var(--line); background:#fff; border-radius:9px; padding:13px; display:grid; gap:9px; }
    .agent-card header { display:flex; justify-content:space-between; align-items:start; gap:10px; }
    .agent-card strong { font-size:16px; }
    .agent-card .meta { display:flex; flex-wrap:wrap; gap:6px; }
    .pill { display:inline-flex; align-items:center; min-height:22px; padding:2px 8px; border-radius:999px; background:#e8f4ef; color:var(--good); font-weight:850; font-size:12px; }
    .pill.warn { background:#fff6dc; color:var(--warn); }
    .pill.bad { background:#fdebf0; color:var(--bad); }
    .pill.busy { background:#e7f0ff; color:#245a96; }
    details { border:1px solid #e0e7ee; border-radius:9px; background:#fbfcfb; padding:11px 12px; }
    summary { cursor:pointer; font-weight:850; color:#29455d; }
    pre { overflow:auto; white-space:pre-wrap; margin:10px 0 0; padding:11px; border-radius:8px; background:#102033; color:#e8f3ff; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:9px; background:#fff; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#eef4f5; color:#46576c; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .muted-row { color:var(--muted); font-size:12px; }
    footer { color:var(--muted); font-size:12px; padding:8px 0 24px; }
    @media (max-width: 1050px) { .checklist-steps { grid-template-columns:repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 900px) { .hero, .two-col, .step-strip, .showcase-grid, .feedback-layout { grid-template-columns:1fr; } .topbar { align-items:flex-start; flex-direction:column; } nav { justify-content:flex-start; } }
    @media (max-width: 620px) { .shell { width:min(100% - 24px, 1180px); } .actions, .inline-actions, .links { flex-direction:column; } .button, button { width:100%; } nav { width:100%; display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); } nav a { width:auto; } h1 { font-size:42px; } .metric-grid { grid-template-columns:1fr; } }
    @media (max-width: 620px) { .checklist-steps { grid-template-columns:1fr; } }

    /* v3 beta console skin: dark tactical surface, same tested controls. */
    :root {
      color-scheme: dark;
      --ink:#e7ebf2;
      --muted:#828ca0;
      --line:#232a3a;
      --paper:#07090d;
      --panel:#11151e;
      --soft:#0b0e14;
      --accent:#f4a64a;
      --accent-2:#7ad7f0;
      --warn:#f0c869;
      --bad:#ff7a6b;
      --good:#7ee0a8;
      --surface-2:#161c28;
      --surface-3:#1d2433;
      --faint:#353c4c;
    }
    html { scroll-padding-top:96px; }
    body {
      background:
        radial-gradient(900px 420px at 18% 0%, rgba(244,166,74,.08), transparent 62%),
        radial-gradient(760px 420px at 92% 22%, rgba(122,215,240,.055), transparent 66%),
        linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px),
        var(--paper);
      background-size:auto, auto, 48px 48px, 48px 48px, auto;
      color:var(--ink);
      font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif;
    }
    body::before { display:none; }
    a { color:var(--accent-2); }
    .shell { width:min(1280px, calc(100% - 40px)); padding:22px 0 56px; }
    .topbar {
      position:sticky;
      top:0;
      z-index:10;
      margin-bottom:24px;
      padding:10px 12px;
      border:1px solid var(--line);
      border-radius:8px;
      background:rgba(11,14,20,.86);
      backdrop-filter:blur(10px);
    }
    .brand { color:var(--ink); }
    .brand-mark {
      border-radius:4px;
      background:transparent;
      border:1px solid rgba(231,235,242,.42);
      color:var(--ink);
      box-shadow:none;
      font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size:12px;
    }
    nav a {
      border-color:var(--line);
      background:var(--panel);
      color:#b7bfcf;
      border-radius:5px;
      font-size:13px;
    }
    nav a:first-child {
      border-color:rgba(244,166,74,.45);
      background:rgba(244,166,74,.13);
      color:var(--accent);
    }
    .card, .hero-copy, .hero-status {
      background:rgba(17,21,30,.94);
      border:1px solid var(--line);
      border-radius:8px;
      box-shadow:0 30px 80px -35px rgba(0,0,0,.72), inset 0 1px 0 rgba(255,255,255,.035);
    }
    .hero-copy { min-height:420px; padding:34px; }
    .hero-status { padding:20px; }
    h1 { max-width:760px; font-size:clamp(48px, 7vw, 84px); letter-spacing:-.035em; }
    h2, h3, .agent-card strong { color:var(--ink); }
    .lede { color:#b7bfcf; font-size:18px; }
    .eyebrow, .section-head .hint strong { color:var(--accent); }
    .hint, .muted-row { color:var(--muted); }
    .prompt-line, .callout, .primary-connect, .feedback-block, .comparison-cell,
    .agent-history-metric, .policy-change-note, .practice-prompt, .step-strip span,
    .checklist-steps li, .feedback-metric, .showcase-stat, .metric, .status-box,
    details, .agent-card, .table-wrap, .agent-start-copy {
      background:var(--soft);
      border-color:var(--line);
      color:#b7bfcf;
    }
    .agent-start-copy strong { color:var(--ink); }
    .prompt-line { color:var(--accent-2); }
    .metric strong, .showcase-stat strong, .feedback-metric strong { color:var(--ink); }
    .metric span, .showcase-stat span, .feedback-metric span, label, th {
      color:#b7bfcf;
    }
    input, select, textarea {
      border-color:var(--line);
      background:#0b0e14;
      color:var(--ink);
      border-radius:5px;
    }
    input:focus, select:focus, textarea:focus {
      outline:none;
      border-color:rgba(244,166,74,.58);
      box-shadow:0 0 0 3px rgba(244,166,74,.12);
    }
    .button, button {
      background:var(--accent);
      color:#1a1206;
      border-color:var(--accent);
      border-radius:5px;
      box-shadow:0 1px 0 rgba(255,255,255,.2) inset, 0 12px 28px -18px rgba(244,166,74,.6);
    }
    .button.secondary, button.secondary, .button.ghost, button.ghost {
      background:var(--surface-2);
      color:var(--ink);
      border-color:var(--line);
      box-shadow:none;
    }
    .button.danger, button.danger {
      background:rgba(255,122,107,.12);
      color:var(--bad);
      border-color:rgba(255,122,107,.36);
      box-shadow:none;
    }
    .pill {
      border:1px solid rgba(126,224,168,.34);
      background:rgba(126,224,168,.12);
      color:var(--good);
      border-radius:3px;
      text-transform:uppercase;
      letter-spacing:.04em;
      font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size:11px;
    }
    .pill.warn {
      border-color:rgba(240,200,105,.34);
      background:rgba(240,200,105,.12);
      color:var(--warn);
    }
    .pill.bad {
      border-color:rgba(255,122,107,.36);
      background:rgba(255,122,107,.12);
      color:var(--bad);
    }
    .pill.busy {
      border-color:rgba(122,215,240,.34);
      background:rgba(122,215,240,.12);
      color:var(--accent-2);
    }
    table, .agent-history-table-wrap { background:var(--soft); border-color:var(--line); }
    th { background:var(--surface-2); }
    td, th { border-color:var(--line); }
    pre { background:#05070a; color:#d7e6f6; border:1px solid var(--line); }
    summary { color:var(--accent-2); }
    footer {
      display:flex;
      justify-content:space-between;
      gap:16px;
      flex-wrap:wrap;
      border-top:1px solid var(--line);
      margin-top:18px;
      padding-top:22px;
    }
    .latest-run-card {
      border:1px solid rgba(126,224,168,.34);
      border-radius:8px;
      background:linear-gradient(180deg, rgba(126,224,168,.08), rgba(11,14,20,.92));
      padding:14px;
      display:grid;
      gap:10px;
    }
    .latest-run-card .links { margin-top:2px; }
    .latest-run-card code { color:var(--accent-2); }
    .console-primary-grid {
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr));
      gap:10px;
    }
    .console-primary-grid a {
      display:grid;
      gap:4px;
      min-height:84px;
      align-content:center;
      padding:12px;
      border:1px solid var(--line);
      border-radius:8px;
      background:var(--soft);
      color:var(--ink);
      text-decoration:none;
    }
    .console-primary-grid span {
      color:var(--muted);
      font-size:12px;
      font-weight:600;
    }
    .critical-flow {
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr));
      gap:10px;
      margin-top:20px;
    }
    .flow-step {
      border:1px solid var(--line);
      border-radius:8px;
      background:rgba(11,14,20,.78);
      padding:12px;
      display:grid;
      gap:5px;
    }
    .flow-step b {
      color:var(--ink);
      font-size:15px;
    }
    .flow-step span {
      color:var(--muted);
      font-size:12px;
    }
    .latest-empty, .empty-state {
      border:1px dashed var(--faint);
      border-radius:8px;
      background:rgba(11,14,20,.58);
      padding:13px;
      color:#b7bfcf;
    }
    .recovery-list {
      margin:10px 0 0;
      padding-left:18px;
      color:var(--muted);
      font-size:13px;
    }
    .recovery-list li { margin:4px 0; }
    .recovery-note {
      border:1px solid rgba(240,200,105,.28);
      border-radius:8px;
      background:rgba(240,200,105,.08);
      padding:10px 12px;
      color:#d8c68b;
      font-size:13px;
    }
    .section-tools {
      display:flex;
      flex-wrap:wrap;
      justify-content:flex-end;
      gap:8px;
      align-items:flex-start;
    }
    .resource-menu {
      min-width:220px;
      padding:0;
    }
    .resource-menu summary {
      min-height:40px;
      display:flex;
      align-items:center;
      padding:0 12px;
    }
    .resource-menu .links {
      padding:0 12px 12px;
      margin-top:0;
    }
    .health-strip {
      margin:12px 0 0;
      border:1px solid rgba(122,215,240,.28);
      border-radius:8px;
      background:rgba(122,215,240,.08);
      padding:10px 12px;
      color:#c7d6e6;
    }
    .health-strip strong {
      color:var(--accent-2);
    }
    .form-help {
      margin-top:7px;
      color:var(--muted);
      font-size:12px;
    }
    .compact-actions {
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      align-items:end;
    }
    .button.compact, button.compact {
      min-height:36px;
      padding:8px 10px;
      font-size:13px;
    }
    main {
      display:flex;
      flex-direction:column;
      gap:16px;
    }
    main > * { scroll-margin-top:96px; }
    #connect { order:1; }
    #agents { order:2; }
    #run-match { order:3; }
    #tester-evidence { order:4; }
    #runs { order:5; }
    #first-agent-checklist { order:6; }
    #agent-feedback { order:7; }
    #showcase { order:8; }
    #beta-feedback-form { order:9; }
    #system-status { order:10; }
    .evidence-card {
      border-color:rgba(122,215,240,.24);
      background:linear-gradient(180deg, rgba(122,215,240,.05), rgba(17,21,30,.94));
    }
    .evidence-packet {
      min-height:150px;
      max-height:260px;
    }
    .supporting-panel > summary {
      list-style:none;
      cursor:pointer;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:16px;
    }
    .supporting-panel > summary::-webkit-details-marker { display:none; }
    .supporting-panel > summary::after {
      content:"Open";
      color:var(--accent-2);
      font-size:12px;
      font-weight:850;
      text-transform:uppercase;
      letter-spacing:.04em;
    }
    .supporting-panel[open] > summary::after { content:"Close"; }
    .supporting-panel > summary h2 { margin:0; }
    .supporting-panel > summary p { margin:.2rem 0 0; }
    .supporting-panel-body { margin-top:16px; display:grid; gap:14px; }
    @media (max-width: 620px) {
      .shell { width:min(100% - 24px, 1180px); }
      .console-primary-grid, .critical-flow { grid-template-columns:1fr; }
      .agent-start-copy, .agent-card-import { grid-template-columns:1fr; }
      .section-head { flex-direction:column; }
      .section-tools { width:100%; flex-direction:column; }
      .resource-menu { width:100%; }
      .hero-copy { min-height:auto; padding:22px; }
      .hero-text-links { width:100%; flex-direction:column; align-items:stretch; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">PW</span>
        <span>Proxy War</span>
        ${model.closedBeta?.enabled ? `<span class="pill warn">${escapeHtml(model.closedBeta.label)}</span>` : ""}
      </div>
      <nav aria-label="Proxy War navigation">
        ${latestReplayLink !== null ? `<a href="${latestReplayLink}" target="_blank">Watch</a>` : `<a href="#runs">Watch</a>`}
        <a href="#connect">Connect</a>
        <a href="#run-match">Run</a>
        <a href="#agents">Agents</a>
      </nav>
    </header>

    <section class="hero">
      <div class="hero-copy">
        <div>
          <div class="eyebrow">A strategy arena for autonomous agents</div>
          <h1>Connect agents. Watch Proxy War unfold.</h1>
          <p class="lede">Paste one Agent Card URL, run a match with Codex-backed house nations, then watch the rendered replay and improve your agent from its decision feedback.</p>
          <div class="prompt-line">Contract: AgentObservation + LegalAction[] → selectedLegalActionId. Agents never submit raw game-engine commands.</div>
          <div class="critical-flow" aria-label="Proxy War beta flow">
            <div class="flow-step"><b>Watch</b><span>Open the latest rendered replay first. This confirms what a successful run produces.</span></div>
            <div class="flow-step"><b>Connect</b><span>Paste one public <code>/agent-card.md</code> URL. The endpoint health check runs before match play.</span></div>
            <div class="flow-step"><b>Run</b><span>Queue the saved tester agent with one Codex house agent against two Easy built-in nations.</span></div>
          </div>
          <div class="actions hero-action-row">
            ${latestReplayLink !== null ? `<a class="button" href="${latestReplayLink}" target="_blank">Watch latest replay</a>` : `<a class="button" href="#connect">Paste Agent Card URL</a>`}
            <div class="hero-text-links">
              <a href="#connect">Connect Agent Card</a>
              <a href="#run-match">Run beta match</a>
              <a href="/agent-start">Agent setup link</a>
            </div>
          </div>
        </div>
        <p class="hint">Beta flow: connect or configure an agent, run the locked beta match, watch the replay, then improve from the feedback surfaces.</p>
      </div>
      <aside class="hero-status">
        <div>
          <div class="eyebrow">Trusted technical beta</div>
          <h2>Latest rendered match</h2>
          <p class="hint">${latestRun ? `Latest run: ${escapeHtml(latestRun.runID)}` : "No match artifacts yet. Run the locked beta match to generate the first rendered replay."}</p>
        </div>
        ${
          latestRun !== null
            ? `<div class="latest-run-card">
                <div>
                  <span class="pill ${latestRun.hasOpenFrontReplay ? "good" : "bad"}">${latestRun.hasOpenFrontReplay ? "Rendered Proxy War replay" : "Replay artifact missing"}</span>
                  <h3>${escapeHtml(latestRun.runID)}</h3>
                  <p class="hint">${escapeHtml(latestRun.brainMode ?? "unknown brain")} · ${escapeHtml(latestRun.scenario ?? "unknown scenario")} · ${escapeHtml(latestRun.runnerMode ?? "unknown mode")}</p>
                </div>
                <div class="metric-grid">
                  <div class="metric"><span>Decisions</span><strong>${numberCell(latestRun.decisionCount)}</strong></div>
                  <div class="metric"><span>Non-hold</span><strong>${numberCell(latestRun.postSpawnNonHoldActionCount)}</strong></div>
                  <div class="metric"><span>Accepted</span><strong>${numberCell(latestRun.acceptedCount)}</strong></div>
                  <div class="metric"><span>Rejected</span><strong>${numberCell(latestRun.rejectedCount)}</strong></div>
                </div>
                <div class="links">
                  ${latestRun.hasOpenFrontReplay ? `<a class="button" href="/proxywar-replay/${encodeURIComponent(latestRun.runID)}" target="_blank">Watch rendered replay</a>` : ""}
                  ${latestRun.hasMatchPackage ? `<a class="button secondary" href="/runs/${encodeURIComponent(latestRun.runID)}/${latestRun.matchPackageLinkFileName}">Match package</a>` : ""}
                  ${!latestRun.hasOpenFrontReplay ? `<a class="button secondary" href="#run-match">Run again</a>` : ""}
                </div>
              </div>`
            : `<div class="latest-empty"><strong>No rendered replay yet.</strong><br>Start with Connect: paste a public <code>/agent-card.md</code> URL, then run the saved roster. When the job completes, the latest replay link appears here.<ul class="recovery-list"><li>If a job failed, read the Status panel before retrying.</li><li>If no agent is saved, connect an Agent Card first for the beta path.</li></ul></div>`
        }
        <div class="console-primary-grid" aria-label="Primary beta actions">
          ${latestReplayLink !== null ? `<a href="${latestReplayLink}" target="_blank"><strong>Watch</strong><span>Latest rendered replay</span></a>` : `<a href="#runs"><strong>Watch</strong><span>No replay yet</span></a>`}
          <a href="#connect"><strong>Connect</strong><span>Paste /agent-card.md</span></a>
          <a href="#run-match"><strong>Run</strong><span>Queue saved roster</span></a>
        </div>
        <div class="metric-grid">
          <div class="metric"><span>Saved agents</span><strong>${model.savedNations.length}</strong></div>
          <div class="metric"><span>External brains</span><strong>${externalAgentCount}</strong></div>
          <div class="metric"><span>Recent runs</span><strong>${model.runs.length}</strong></div>
          <div class="metric"><span>Showcases</span><strong>${model.tournaments.length}</strong></div>
          <div class="metric"><span>Queued job</span><strong>${activeJob ? "Yes" : "No"}</strong></div>
        </div>
        <div id="active-job-status" class="status-box">${activeJob ? `<strong>Match job: ${escapeHtml(activeJob.status)}</strong><br>${escapeHtml(activeJob.label)}<br><span class="hint">Leave this tab open. If the job fails, the recovery hint appears here before you retry.</span>` : "No match running. If a run fails later, the latest useful error and recovery hint will appear here."}</div>
      </aside>
    </section>

    <main>
      <section id="first-agent-checklist" class="card checklist-card" aria-label="First agent checklist">
        <div class="section-head">
          <div>
            <h2>First Agent Checklist</h2>
            <p class="hint">A single visible path from imported agent to first feedback artifact.</p>
          </div>
          <div class="checklist-progress">
            <span id="first-agent-checklist-progress" class="pill">0/5 complete</span>
            <a class="button secondary" href="#connect">Continue setup</a>
          </div>
        </div>
        <ol class="checklist-steps">
          <li data-checklist-step="cardImported">
            <span class="check-index">1</span>
            <div>
              <h3>Import Agent Card</h3>
              <p class="hint">Paste the public markdown card so the nation profile and endpoint are discoverable.</p>
            </div>
            <span class="check-state" data-checklist-state>Waiting</span>
          </li>
          <li data-checklist-step="endpointTested">
            <span class="check-index">2</span>
            <div>
              <h3>Test Endpoint</h3>
              <p class="hint">Pass starter self-test or Test Endpoint so the service returns one offered LegalAction.id before it enters a match.</p>
            </div>
            <span class="check-state" data-checklist-state>Waiting</span>
          </li>
          <li data-checklist-step="agentSaved">
            <span class="check-index">3</span>
            <div>
              <h3>Save Agent</h3>
              <p class="hint">Store the entrant for protocol checks and future external-agent runs.</p>
            </div>
            <span class="check-state" data-checklist-state>Waiting</span>
          </li>
          <li data-checklist-step="firstMatchRun">
            <span class="check-index">4</span>
            <div>
              <h3>Run First Match</h3>
            <p class="hint">Generate a bounded rendered replay and decision artifacts from the saved roster.</p>
            </div>
            <span class="check-state" data-checklist-state>Waiting</span>
          </li>
          <li data-checklist-step="feedbackOpened">
            <span class="check-index">5</span>
            <div>
              <h3>Open Feedback</h3>
              <p class="hint">Review the external-agent feedback artifact and iterate on the agent.</p>
            </div>
            <span class="check-state" data-checklist-state>Waiting</span>
          </li>
        </ol>
        <div class="links checklist-links">
          <a href="#connect">Import or save agent</a>
          <a href="#run-match">Run match</a>
          ${latestFeedbackLink !== null ? `<a href="${latestFeedbackLink}" target="_blank" data-checklist-feedback-link>Open latest feedback</a>` : ""}
        </div>
      </section>

      ${publicExternalFeedbackPanel(latestFeedbackRun, previousFeedbackRun, feedbackRuns, model.savedNations)}

      <details id="showcase" class="card supporting-panel">
        <summary>
          <div>
            <h2>Agent League Showcase</h2>
            <p class="hint">A public-safe sample tournament: distinct agent styles, leaderboard, highlight reel, and one rendered match to watch first.</p>
          </div>
        </summary>
        <div class="supporting-panel-body">
          <div class="inline-actions">
            ${latestTournamentReplayLink !== null ? `<a class="button" href="${latestTournamentReplayLink}" target="_blank">Watch showcase replay</a>` : ""}
            ${latestTournament !== null ? `<a class="button secondary" href="/tournaments/${encodeURIComponent(latestTournament.tournamentID)}/leaderboard.html" target="_blank">Open leaderboard</a>` : ""}
          </div>
        ${
          latestTournament === null
            ? `<div class="showcase-grid">
                <div>
                  <p class="hint">No showcase tournament is ready yet. Run one to create a public entry point with a replay, leaderboard, and match story.</p>
                  <button id="run-showcase-tournament" class="button" type="button">Generate Agent Showcase</button>
                </div>
                <div class="status-box">The generated showcase uses curated local planner nations only. Built-in opponents are reserved for explicit benchmarks.</div>
              </div>`
            : `<div class="showcase-grid">
                <div>
                  <div class="showcase-stats">
                    <div class="showcase-stat"><span>Status</span><strong>${escapeHtml(latestTournament.showcase?.status ?? "ready")}</strong></div>
                    <div class="showcase-stat"><span>Entertainment</span><strong>${numberCell(latestTournament.showcase?.averageEntertainmentScore)}/100</strong></div>
                    <div class="showcase-stat"><span>Runs</span><strong>${numberCell(latestTournament.runCount)}</strong></div>
                    <div class="showcase-stat"><span>Actions</span><strong>${numberCell(latestTournament.postSpawnNonHoldActionCount)}</strong></div>
                  </div>
                  <ul class="highlight-list">
                    ${showcaseHighlights || "<li>Run a longer showcase to build a highlight reel.</li>"}
                  </ul>
                </div>
                <div>
                  ${showcaseAgentCards ? `<div class="roster-grid">${showcaseAgentCards}</div>` : ""}
                  ${showcaseLeaderboardRows ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Rank</th><th>Agent</th><th>Score</th></tr></thead><tbody>${showcaseLeaderboardRows}</tbody></table></div>` : ""}
                </div>
              </div>`
        }
        <div id="showcase-status" class="status-box">Ready.</div>
        </div>
      </details>

      <section id="connect" class="card">
        <div class="section-head">
          <div>
            <div class="eyebrow">C · Connect your agent</div>
            <h2>Paste your agent's /agent-card.md link.</h2>
            <p class="hint">Send your coding agent the setup link below. When it returns a public Agent Card URL, paste it here. Proxy War imports the nation profile, tests the endpoint, queues a match, and returns a replay.</p>
          </div>
          <div class="section-tools">
            <a class="button secondary compact" href="/agent-start">Open setup link</a>
            <details class="resource-menu">
              <summary>Developer resources</summary>
              <div class="links">
                <a href="/examples/external-agent/README.md" target="_blank">Starter SDK guide</a>
                <a href="https://github.com/0xNad/ProxyWar-starter-agent" target="_blank" rel="noopener noreferrer">GitHub starter template</a>
                <a href="/examples/external-agent/PROXYWAR_AGENT_CARD.md" target="_blank">Agent Card template</a>
              </div>
            </details>
          </div>
        </div>
        <div class="agent-start-copy">
          <div>
            <strong>Agent setup link</strong>
            <p class="hint">Give this to Claude, Hermes, OpenClaw, or another coding agent: build the endpoints, pass the starter self-test, publish an Agent Card, then return the card URL.</p>
            <code id="agent-start-url">/agent-start</code>
          </div>
          <button class="secondary" type="button" data-copy-target="agent-start-url">Copy setup link</button>
        </div>
        <div class="primary-connect">
          <form id="agent-card-form" class="agent-card-import">
            <div>
              <label for="agentCardUrl">Agent Card URL</label>
              <input id="agentCardUrl" name="cardUrl" type="url" required placeholder="https://your-agent.example/agent-card.md">
            <div class="form-help">Use the public markdown card URL after the endpoint passes self-test. Its frontmatter must point <code>endpointUrl</code> at the POST decision endpoint.</div>
            </div>
            <div class="compact-actions">
              <button type="submit" name="action" value="import-and-run">Import & Run Match</button>
              <button class="secondary compact" type="submit" name="action" value="import">Import Only</button>
            </div>
            <details class="token-field">
              <summary>Endpoint needs a bearer token?</summary>
              <input name="endpointToken" type="password" maxlength="512" autocomplete="off" placeholder="Paste a beta-only bearer token here, not in the markdown card">
            </details>
          </form>
          <div id="endpoint-health-summary" class="health-strip" aria-live="polite"><strong>Endpoint health:</strong> not checked yet. If it fails, fix the response contract before running a match.</div>
          <div id="agent-card-status" class="status-box" aria-live="polite"><strong>Agent Card not imported yet.</strong> Paste a public <code>/agent-card.md</code> URL and Proxy War will show the import, health-check, and match result here.<ul class="recovery-list"><li>Card URL ends in <code>/agent-card.md</code>.</li><li>Card frontmatter has <code>endpointUrl</code> pointing at <code>/proxywar/decide</code>.</li><li>Run <code>npm run self-test</code> before importing.</li></ul></div>
          <p class="hint">The markdown card is public setup data. Secrets are pasted separately and stored as local secret references.</p>
        </div>
        <details class="advanced-connect">
          <summary>Windows setup note</summary>
          <p class="hint">The starter is a Node.js project, not a Windows app. If Windows says it cannot open the downloaded file, extract the GitHub ZIP first, then open PowerShell in the extracted folder and run <code>npm install</code> followed by <code>npm start</code>.</p>
        </details>
        <details class="advanced-connect">
          <summary>Advanced: paste endpoint manually</summary>
          <div class="two-col">
          <form id="external-agent-form">
            <input type="hidden" name="agentMode" value="external-http">
            <label for="externalAgentName">Nation name</label>
            <input id="externalAgentName" name="agentName" type="text" maxlength="60" value="Remote Frontier">
            <label for="externalProfile">Profile</label>
            <select id="externalProfile" name="profile">
              <option value="aggressive">Aggressive</option>
              <option value="defensive">Defensive</option>
              <option value="diplomatic">Diplomatic</option>
              <option value="opportunistic">Opportunistic</option>
            </select>
            <input type="hidden" name="doctrine" value="balanced">
            <label for="endpointUrl">Agent endpoint URL</label>
            <input id="endpointUrl" name="endpointUrl" type="url" placeholder="https://example.com/proxywar/decide">
            <label for="endpointToken">Bearer token <span class="hint">(optional)</span></label>
            <input id="endpointToken" name="endpointToken" type="password" maxlength="512" autocomplete="off" placeholder="Paste a beta-only endpoint token">
            <label for="endpointTimeoutMs">Decision timeout ms</label>
            <input id="endpointTimeoutMs" name="endpointTimeoutMs" type="number" min="250" max="180000" value="120000">
            <label for="externalPersonality">Agent note</label>
            <input id="externalPersonality" name="personality" type="text" maxlength="240" value="External endpoint controls decisions through the LegalAction.id contract.">
            <label for="externalPolicyChangelog">Policy changelog</label>
            <textarea id="externalPolicyChangelog" name="policyChangelog" maxlength="600" placeholder="What changed in this agent since the last run? Example: Added repetition penalty and safer economy timing."></textarea>
            <div class="inline-actions">
              <button id="test-external-agent" class="ghost" type="button">Test Endpoint</button>
              <button type="submit">Save Agent</button>
            </div>
            <div id="external-agent-check-output" class="status-box"><strong>Endpoint not tested yet.</strong> Return one offered LegalAction.id to pass.</div>
          </form>
          <div class="callout">
            <h3>Copy-paste LLM starter</h3>
            <p class="hint">Run this locally with Codex CLI, Claude/Cowork, OpenRouter, or another command while developing. It serves <code>/health</code>, <code>http://127.0.0.1:7777/agent-card.md</code>, and <code>/proxywar/decide</code> on your machine. Do not use <code>127.0.0.1</code> with the remote beta; expose the starter through public HTTPS first. The template repo also includes <code>npm run self-test</code>; pass that before pasting the Agent Card URL above.</p>
            <div class="inline-actions">
              <button class="ghost" type="button" data-copy-target="starter-agent-run-command">Copy starter command</button>
              <a class="button secondary" href="/examples/external-agent/README.md" target="_blank">Example README</a>
              <a class="button secondary" href="/examples/external-agent/PROXYWAR_AGENT_CARD.md" target="_blank">Agent Card template</a>
            </div>
            <pre id="starter-agent-run-command">${escapeHtml(starterAgentRunCommand)}</pre>
            <details>
              <summary>Starter skill prompt</summary>
              <pre id="starter-agent-skill">${escapeHtml(starterAgentSkillPrompt)}</pre>
            </details>
          </div>
          </div>
        </details>
      </section>

      <section id="run-match" class="card">
        <div class="section-head">
          <div>
            <div class="eyebrow">E · Run match</div>
            <h2>Run Match</h2>
            <p class="hint">Starts the locked beta match: the latest saved tester agent plus one ${escapeHtml(houseAgentBrainLabel)} agent against two Easy built-in nations until a winner emerges.</p>
          </div>
          <button id="run-external-match" class="button" type="button">Run Codex Match</button>
        </div>
        <div id="first-match-status" class="status-box" aria-live="polite">Ready. House agent: ${escapeHtml(houseAgentBrainLabel)}. The default match uses the latest saved tester agent and two Easy built-in nations, and it must finish with a winner.<ul class="recovery-list"><li>Connect and save an external agent before running the tester match.</li><li>If endpoint health fails, fix <code>selectedLegalActionId</code> before saving the agent.</li></ul></div>
      </section>

      <section id="tester-evidence" class="card evidence-card">
        <div class="section-head">
          <div>
            <div class="eyebrow">F · Share result</div>
            <h2>Tester Evidence Packet</h2>
            <p class="hint">After a run, copy this into Discord, Slack, or an issue so a tester can report exactly what happened.</p>
          </div>
          <button class="secondary compact" type="button" data-copy-target="tester-evidence-packet">Copy evidence packet</button>
        </div>
        <pre id="tester-evidence-packet" class="evidence-packet" aria-live="polite">${escapeHtml(initialTesterEvidencePacket)}</pre>
      </section>

      <section id="agents" class="card">
        <div class="section-head">
          <div>
            <div class="eyebrow">D · Saved agents</div>
            <h2>Saved Agents</h2>
            <p class="hint">Keep this list clean before inviting testers. Delete stale local endpoints so they do not block the single beta queue.</p>
          </div>
          <details>
            <summary>Create reference nation</summary>
            <form id="nation-form">
              <label for="agentName">Nation name</label>
              <input id="agentName" name="agentName" type="text" maxlength="60" value="Iron Coast">
              <label for="profile">Profile</label>
              <select id="profile" name="profile">
                <option value="aggressive">Aggressive</option>
                <option value="defensive" selected>Defensive</option>
                <option value="diplomatic">Diplomatic</option>
                <option value="opportunistic">Opportunistic</option>
              </select>
              <label for="doctrine">Doctrine</label>
              <select id="doctrine" name="doctrine">
                <option value="balanced">Balanced</option>
                <option value="economic">Economic</option>
                <option value="fortress">Fortress</option>
                <option value="diplomatic">Diplomatic</option>
                <option value="pressure">Pressure</option>
              </select>
              <label for="personality">Doctrine note</label>
              <input id="personality" name="personality" type="text" maxlength="240" value="Build a strong economy, avoid bad wars, and expand when the border is safe.">
              <label for="policyChangelog">Policy changelog</label>
              <textarea id="policyChangelog" name="policyChangelog" maxlength="600" placeholder="Optional: describe the latest policy change before the next run."></textarea>
              <button class="secondary" type="submit">Save Reference Nation</button>
            </form>
          </details>
        </div>
        <div class="health-strip"><strong>Roster status:</strong> ${model.savedNations.length === 0 ? "No saved agents yet. Connect an Agent Card before asking a tester to run." : `${model.savedNations.length} saved entrant${model.savedNations.length === 1 ? "" : "s"} ready. Re-test external endpoints after policy, tunnel, domain, or hosting changes.`}</div>
        ${
          model.savedNations.length === 0
            ? `<div class="empty-state"><strong>No saved agents yet.</strong><br>Paste an Agent Card above to create the first saved entrant. Reference nations are available for operator checks, but the tester flow should start with an imported external agent.<ul class="recovery-list"><li>Use <a href="/agent-start">Agent setup link</a> if the developer has not built the endpoints yet.</li><li>Use <strong>Import Only</strong> first if you want to verify the card before running.</li></ul></div>`
            : `<div class="roster-grid">${savedCards}</div>`
        }
      </section>

      <section id="runs" class="card">
        <div class="section-head">
          <div>
            <div class="eyebrow">G · Recent runs</div>
            <h2>Recent Runs</h2>
            <p class="hint">Rendered gameplay is the primary artifact. Decision reports are for debugging.</p>
          </div>
          ${latestReplayLink !== null ? `<a class="button secondary" href="${latestReplayLink}" target="_blank">Open latest replay</a>` : ""}
        </div>
        ${
          recentRows === ""
            ? `<div class="empty-state"><strong>No runs yet.</strong><br>Run the locked beta match. When a replay artifact is attached, the latest replay button appears at the top of this page.</div>`
            : `<div class="table-wrap"><table><thead><tr><th>Run</th><th>Decisions</th><th>Links</th></tr></thead><tbody>${recentRows}</tbody></table></div>`
        }
      </section>

      ${
        model.closedBeta?.enabled
          ? `<section id="beta-feedback-form" class="card">
              <div class="eyebrow">H · Feedback & docs</div>
              <h2>Feedback</h2>
              <form id="feedback-form">
                <label for="testerName">Name</label>
                <input id="testerName" name="testerName" type="text" maxlength="80" placeholder="Optional">
                <label for="rating">How did it feel?</label>
                <select id="rating" name="rating">
                  <option value="great">Great</option>
                  <option value="okay">Okay</option>
                  <option value="confusing">Confusing</option>
                  <option value="broken">Broken</option>
                </select>
                <label for="runID">Run id</label>
                <input id="runID" name="runID" type="text" maxlength="160" value="${latestRun ? escapeAttribute(latestRun.runID) : ""}" placeholder="Optional">
                <label for="comment">Comment</label>
                <textarea id="comment" name="comment" placeholder="What was confusing, exciting, or broken?"></textarea>
                <button class="secondary" type="submit">Send Feedback</button>
              </form>
            </section>`
          : ""
      }

      <section id="system-status" class="card">
        <h2>Status</h2>
        <div id="job-output" class="status-box">Ready.</div>
      </section>
    </main>
    <footer>
      <span>Proxy War is an experimental autonomous-agent strategy arena built on an AGPL-licensed open-source game engine.</span>
      <span class="links">
        <a href="/docs/PROXYWAR_ASSET_AND_LICENSE_AUDIT.md" target="_blank">Source, credits & license notes</a>
        <a href="/docs/PROXYWAR_TESTER_HANDOFF.md" target="_blank">Tester handoff</a>
        <a href="/docs/PROXYWAR_EXTERNAL_AGENT_API.md" target="_blank">Agent API</a>
        ${model.closedBeta?.enabled ? `<a href="/api/beta/logout">Sign out</a>` : `<a href="/admin">Admin</a>`}
      </span>
    </footer>
  </div>
  <script>
    const output = document.getElementById("job-output");
    const activeJobStatus = document.getElementById("active-job-status");
    const firstMatchStatus = document.getElementById("first-match-status");
    const agentCardStatus = document.getElementById("agent-card-status");
    const endpointHealthSummary = document.getElementById("endpoint-health-summary");
    const externalAgentForm = document.getElementById("external-agent-form");
    const externalCheckOutput = document.getElementById("external-agent-check-output");
    const runExternalMatchButton = document.getElementById("run-external-match");
    const rerunFeedbackMatchButton = document.getElementById("rerun-feedback-match");
    const agentFeedbackStatus = document.getElementById("agent-feedback-status");
    const runShowcaseTournamentButton = document.getElementById("run-showcase-tournament");
    const showcaseStatus = document.getElementById("showcase-status");
    const testerEvidencePacket = document.getElementById("tester-evidence-packet");
    const initialActiveJobID = ${JSON.stringify(activeJob?.jobID ?? null)};
    const initialSavedAgentCount = ${JSON.stringify(model.savedNations.length)};
    const testerEvidenceState = ${JSON.stringify(initialTesterEvidenceState)};
    const firstAgentChecklistKey = "proxywar-first-agent-checklist-v1";
    const firstAgentChecklistServerState = ${JSON.stringify(firstAgentChecklistServerState)};
    const firstAgentChecklistOrder = ["cardImported", "endpointTested", "agentSaved", "firstMatchRun", "feedbackOpened"];
    let firstAgentChecklistState = readChecklistState();
    hydrateAgentStartUrl();
    renderTesterEvidencePacket();
    renderFirstAgentChecklist();
    setupSamePageNav();

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-checklist-feedback-link]")
        : null;
      if (target) {
        markChecklistStep("feedbackOpened");
      }
    });

    function setupSamePageNav() {
      for (const link of document.querySelectorAll('a[href^="#"]')) {
        link.addEventListener("click", (event) => {
          const href = link.getAttribute("href") || "";
          if (href.length <= 1) return;
          const target = document.getElementById(decodeURIComponent(href.slice(1)));
          if (!target) return;
          event.preventDefault();
          history.replaceState(null, "", href);
          scrollToSection(target, "smooth");
        });
      }
      if (window.location.hash) {
        window.setTimeout(() => {
          const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
          if (target) scrollToSection(target, "auto");
        }, 60);
      }
    }

    function hydrateAgentStartUrl() {
      const target = document.getElementById("agent-start-url");
      if (target) target.textContent = window.location.origin + "/agent-start";
    }

    function validateAgentCardUrl(formData) {
      const value = String(formData.get("cardUrl") || "").trim();
      if (!value) {
        throw new Error("Paste the public /agent-card.md URL.");
      }
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error("Agent Card URL must be a full public URL, for example https://host/agent-card.md.");
      }
      if (!parsed.pathname.endsWith("/agent-card.md")) {
        const message = "Agent Card URL should end with /agent-card.md. Put /proxywar/decide only in the card's endpointUrl field.";
        setAgentCardStatus("<strong>Check the URL.</strong> " + escapeText(message) + agentCardUrlRecoveryHtml());
        throw new Error(message);
      }
    }

    function scrollToSection(target, behavior) {
      const topbar = document.querySelector(".topbar");
      const offset = topbar instanceof HTMLElement ? topbar.getBoundingClientRect().height + 22 : 88;
      const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - offset);
      window.scrollTo({ top, behavior });
    }

    for (const copyButton of document.querySelectorAll("[data-copy-target]")) {
      copyButton.addEventListener("click", async () => {
        const target = document.getElementById(copyButton.dataset.copyTarget || "");
        if (!target) return;
        const original = copyButton.textContent || "Copy";
        try {
          await copyText(target.textContent || "");
          copyButton.textContent = "Copied";
          setTimeout(() => { copyButton.textContent = original; }, 1400);
        } catch {
          copyButton.textContent = "Copy failed";
          setTimeout(() => { copyButton.textContent = original; }, 1600);
        }
      });
    }

    for (const form of [
      document.getElementById("agent-card-form"),
      document.getElementById("external-agent-form"),
      document.getElementById("nation-form"),
      document.getElementById("feedback-form")
    ].filter(Boolean)) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const buttons = Array.from(form.querySelectorAll("button[type=submit]"));
        for (const button of buttons) button.disabled = true;
        let agentCardFailureHtml = "";
        try {
          const formData = new FormData(form);
          if (form.id === "agent-card-form") {
            validateAgentCardUrl(formData);
          }
          const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
          const submitAction = submitter?.name === "action" ? submitter.value : "";
          const endpoint = form.id === "feedback-form"
            ? "/api/beta/feedback"
            : form.id === "agent-card-form"
              ? submitAction === "import-and-run"
                ? "/api/agent-cards/import-and-run"
                : "/api/agent-cards/import"
              : "/api/nations";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(Object.fromEntries(formData.entries()))
          });
          const result = await response.json();
          if (!response.ok) {
            if (form.id === "agent-card-form" && result.health) {
              agentCardFailureHtml = "<strong>Agent Card import stopped at endpoint health check.</strong><br>" + externalHealthCheckHtml(result.health);
              setEndpointHealthStatus(result.health);
            }
            throw new Error(result.error || result.failureReason || "request failed");
          }
          if (form.id === "agent-card-form") {
            updateTesterEvidenceAgentCardUrl(String(formData.get("cardUrl") || ""));
          }
          if (endpoint === "/api/nations" || endpoint === "/api/agent-cards/import" || endpoint === "/api/agent-cards/import-and-run") {
            updateTesterEvidenceAgent(result.nation);
            if (endpoint === "/api/agent-cards/import") {
              markChecklistStep("cardImported");
              markChecklistStep("agentSaved");
            } else if (endpoint === "/api/agent-cards/import-and-run") {
              markChecklistStep("cardImported");
              markChecklistStep("endpointTested");
              markChecklistStep("agentSaved");
            } else if (form.id === "external-agent-form") {
              markChecklistStep("agentSaved");
            }
            if (result.health) setEndpointHealthStatus(result.health);
            const prefix = endpoint === "/api/agent-cards/import" || endpoint === "/api/agent-cards/import-and-run" ? "Imported Agent Card" : "Saved agent";
            const warningText = Array.isArray(result.card?.warnings) && result.card.warnings.length
              ? "\\nWarnings: " + result.card.warnings.join("; ")
              : "";
            if (endpoint === "/api/agent-cards/import-and-run") {
              const healthStatus = result.health
                ? "<br><strong>Endpoint health check:</strong><br>" + externalHealthCheckHtml(result.health)
                : "";
              const healthSummary = result.health
                ? "\\nHealth check: passed" + (result.health.selectedLegalActionId ? "\\nSelected: " + result.health.selectedLegalActionId : "")
                : "";
              const importStatus = "<strong>" + escapeText(prefix) + ":</strong> " + escapeText(result.nation.agentName) + "<br>Active roster size: " + escapeText(String(result.activeRosterCount)) + escapeText(warningText).replace(/\\n/g, "<br>") + healthStatus + "<br>Queued match: <code>" + escapeText(result.jobID) + "</code>";
              setAgentCardStatus(importStatus);
              setStatus(prefix + ": " + result.nation.agentName + "\\nActive roster size: " + result.activeRosterCount + warningText + healthSummary + "\\nQueued match: " + result.jobID);
              await pollJob(result.jobID, { autoWatch: true });
            } else {
              setAgentCardStatus("<strong>" + escapeText(prefix) + ":</strong> " + escapeText(result.nation.agentName) + "<br>Active roster size: " + escapeText(String(result.activeRosterCount)) + escapeText(warningText).replace(/\\n/g, "<br>"));
              setStatus(prefix + ": " + result.nation.agentName + "\\nActive roster size: " + result.activeRosterCount + warningText + "\\nRefreshing roster...");
              setTimeout(() => window.location.href = "/public#agents", 700);
            }
          } else {
            setStatus("Thanks. Feedback recorded: " + result.feedbackID);
          }
        } catch (error) {
          if (form.id === "agent-card-form") {
            updateTesterEvidenceAgentCardUrl(String(new FormData(form).get("cardUrl") || ""));
            setAgentCardStatus(agentCardFailureHtml || "<strong>Agent Card import failed.</strong> " + escapeText(String(error)) + agentCardUrlRecoveryHtml(String(error)));
          }
          updateTesterEvidenceFailure(String(error));
          setStatus(String(error));
        } finally {
          for (const button of buttons) button.disabled = false;
        }
      });
    }

    for (const button of document.querySelectorAll("[data-delete-nation-id]")) {
      button.addEventListener("click", async () => {
        const nationName = button.dataset.deleteNationName || "this agent";
        if (!window.confirm("Delete " + nationName + " from the saved roster?")) return;
        button.disabled = true;
        try {
          const response = await fetch("/api/nations/" + encodeURIComponent(button.dataset.deleteNationId || ""), { method: "DELETE" });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "delete failed");
          setStatus("Deleted agent: " + result.deletedNation.agentName + "\\nActive roster size: " + result.activeRosterCount + "\\nRefreshing roster...");
          setTimeout(() => window.location.href = "/public#agents", 700);
        } catch (error) {
          button.disabled = false;
          setStatus(String(error));
        }
      });
    }

    const testExternalButton = document.getElementById("test-external-agent");
    if (testExternalButton && externalAgentForm) {
      testExternalButton.addEventListener("click", async () => {
        testExternalButton.disabled = true;
        setStatus("Testing external agent endpoint...");
        setExternalCheckStatus("<strong>Endpoint health check running...</strong> Waiting for strict JSON with one offered LegalAction.id.");
        try {
          const response = await fetch("/api/external-agents/check", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(externalAgentForm).entries()))
          });
          const result = await response.json();
          setExternalCheckStatus(externalHealthCheckHtml(result));
          setEndpointHealthStatus(result);
          if (!response.ok || !result.ok) throw new Error(result.failureReason || result.error || "endpoint check failed");
          markChecklistStep("endpointTested");
          setStatus(["Endpoint passed", "Selected: " + result.selectedLegalActionId, "Reason: " + result.reason, "Latency: " + result.latencyMs + "ms"].join("\\n"));
      } catch (error) {
          setExternalCheckStatus("<strong>Endpoint health check failed.</strong> " + escapeText(String(error)) + endpointRecoveryHtml(String(error)));
          setStatus(String(error));
        } finally {
          testExternalButton.disabled = false;
        }
      });
    }

    if (runExternalMatchButton) {
      runExternalMatchButton.addEventListener("click", async () => {
        await startSavedRosterMatch(firstMatchStatus, runExternalMatchButton, "Starting match...", {
          autoWatch: true,
          refreshFeedback: false
        });
      });
    }

    if (rerunFeedbackMatchButton) {
      rerunFeedbackMatchButton.addEventListener("click", async () => {
        await startSavedRosterMatch(agentFeedbackStatus, rerunFeedbackMatchButton, "Starting rerun...", {
          autoWatch: false,
          refreshFeedback: true
        });
      });
    }

    if (runShowcaseTournamentButton) {
      runShowcaseTournamentButton.addEventListener("click", async () => {
        runShowcaseTournamentButton.disabled = true;
        setShowcaseStatus("<strong>Generating showcase...</strong> Curated agents are entering a short public-safe tournament.");
        try {
          const response = await fetch("/api/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "tournament", brain: "planner", scenario: "actions", runs: 1, maxSteps: 6, bots: 0, nations: 0, replayTailTurns: 500 })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "showcase request failed");
          setShowcaseStatus("<strong>Showcase queued.</strong> Job <code>" + escapeText(result.jobID) + "</code>");
          const finalJob = await pollJob(result.jobID);
          if (finalJob?.status === "completed") {
            setShowcaseStatus(publicJobStatusHtml(finalJob));
          }
        } catch (error) {
          setShowcaseStatus("<strong>Could not generate showcase.</strong> " + escapeText(String(error)));
        } finally {
          runShowcaseTournamentButton.disabled = false;
        }
      });
    }

    if (initialActiveJobID) {
      pollJob(initialActiveJobID).catch((error) => {
        if (activeJobStatus) activeJobStatus.textContent = String(error);
      });
    }

    async function pollJob(jobID, options = {}) {
      while (true) {
        const response = await fetch("/api/jobs/" + encodeURIComponent(jobID));
        const job = await response.json();
        updateTesterEvidenceFromJob(job);
        const html = publicJobStatusHtml(job, options);
        setStatusText(html);
        if (activeJobStatus) activeJobStatus.innerHTML = html;
        if (firstMatchStatus) firstMatchStatus.innerHTML = html;
        if (showcaseStatus) showcaseStatus.innerHTML = html;
        if (job.status === "completed" && job.latestRunID) {
          markChecklistStep("firstMatchRun");
        }
        if (job.status === "completed" || job.status === "failed") return job;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    function publicJobStatusHtml(job, options = {}) {
      const autoWatch = options.autoWatch !== false;
      const refreshFeedback = options.refreshFeedback === true;
      const readyRunID = job.status === "completed" ? job.latestRunID : undefined;
      const readyTournamentID = job.status === "completed" ? job.latestTournamentID : undefined;
      const readyEvaluationID = job.status === "completed" ? job.latestEvaluationID : undefined;
      const watchUrl = readyRunID ? "/proxywar-replay/" + encodeURIComponent(readyRunID) : "";
      const tournamentUrl = readyTournamentID ? "/tournaments/" + encodeURIComponent(readyTournamentID) + "/leaderboard.html" : "";
      const evaluationUrl = readyEvaluationID ? "/evaluations/" + encodeURIComponent(readyEvaluationID) + "/evaluation-report.md" : "";
      const completedWithoutArtifact = job.status === "completed" && !readyRunID && !readyTournamentID && !readyEvaluationID;
      if (job.status === "completed" && watchUrl && autoWatch && !window.__proxyWarAutoWatchRunID) {
        window.__proxyWarAutoWatchRunID = readyRunID;
        setTimeout(() => { window.location.href = watchUrl; }, 1200);
      }
      if (job.status === "completed" && readyRunID && refreshFeedback && !window.__proxyWarRefreshFeedbackRunID) {
        window.__proxyWarRefreshFeedbackRunID = readyRunID;
        setTimeout(() => { window.location.href = "/public#agent-feedback"; }, 1200);
      }
      return [
        "<strong>Match job: " + escapeText(job.status) + "</strong>",
        job.label ? "Type: " + escapeText(job.label) : "",
        readyRunID ? "Run: <code>" + escapeText(readyRunID) + "</code>" : readyTournamentID ? "Tournament: <code>" + escapeText(readyTournamentID) + "</code>" : readyEvaluationID ? "Evaluation: <code>" + escapeText(readyEvaluationID) + "</code>" : completedWithoutArtifact ? "Completed, but no replay or report artifact was attached." : "Waiting for replay artifact...",
        readyRunID ? "<div class=\\"links\\"><a class=\\"button\\" href=\\"" + watchUrl + "\\">Watch replay</a><a class=\\"button secondary\\" href=\\"/runs/" + encodeURIComponent(readyRunID) + "/external-agent-feedback.md\\" data-checklist-feedback-link>Agent feedback</a></div><details><summary>Debug artifacts</summary><div class=\\"links\\"><a href=\\"/runs/" + encodeURIComponent(readyRunID) + "/match-package.html\\">Match package</a><a href=\\"/runs/" + encodeURIComponent(readyRunID) + "/visual-report.html\\">Decision report</a><a href=\\"/runs/" + encodeURIComponent(readyRunID) + "/spectator.html\\">Timeline</a><a href=\\"/public#agent-feedback\\">Refresh comparison</a></div></details>" : "",
        job.status === "completed" && readyRunID && refreshFeedback ? "<span class=\\"pill busy\\">Refreshing comparison...</span>" : "",
        readyTournamentID ? "<div class=\\"links\\"><a href=\\"" + tournamentUrl + "\\">Open tournament leaderboard</a><a href=\\"/tournaments/" + encodeURIComponent(readyTournamentID) + "/tournament-report.md\\">Tournament report</a></div>" : "",
        readyEvaluationID ? "<div class=\\"links\\"><a href=\\"" + evaluationUrl + "\\">Evaluation report</a></div>" : "",
        completedWithoutArtifact ? "<span class=\\"pill bad\\">Replay missing</span> The job says completed, but Proxy War could not attach a rendered replay. Rerun the match and ask the operator to check for game-record.json and spectator-replay.json." : "",
        job.status === "failed" ? "<span class=\\"pill bad\\">Failed</span> " + escapeText(job.errorSummary || "No clear error was reported.") + jobRecoveryHtml(job) : "",
        job.status === "queued" ? "<span class=\\"hint\\">Queued. The beta queue is intentionally small; leave this tab open and avoid clicking Run again.</span>" : "",
        job.status === "running" ? "<span class=\\"hint\\">Match is running. Short beta runs can still take a few minutes while agents decide. Leave this tab open.</span>" : ""
      ].filter(Boolean).join("<br>");
    }

    function externalHealthCheckHtml(result) {
      const ok = result && result.ok === true;
      const offered = Array.isArray(result?.offeredLegalActionIDs) ? result.offeredLegalActionIDs : [];
      return [
        "<strong><span class=\\"pill " + (ok ? "good" : "bad") + "\\">" + (ok ? "Passed" : "Failed") + "</span></strong>",
        result?.selectedLegalActionId ? "Selected: <code>" + escapeText(result.selectedLegalActionId) + "</code>" : "",
        result?.reason ? "Reason: " + escapeText(result.reason) : "",
        result?.failureReason ? "Failure: " + escapeText(result.failureReason) : "",
        result?.fixHint ? "Fix: " + escapeText(result.fixHint) : "",
        !ok ? endpointRecoveryHtml(result?.failureReason || result?.error || result?.fixHint || "") : "",
        offered.length ? "Offered: " + offered.map((id) => "<code>" + escapeText(id) + "</code>").join(" ") : "",
        result?.request?.method ? "Check sent: <code>" + escapeText(result.request.method) + " " + escapeText(result.endpoint || "") + "</code>" : "",
        result?.rawOutput ? "<details><summary>Raw output</summary><pre>" + escapeText(result.rawOutput) + "</pre></details>" : ""
      ].filter(Boolean).join("<br>");
    }

    function renderTesterEvidencePacket() {
      if (!testerEvidencePacket) return;
      testerEvidencePacket.textContent = [
        "Proxy War tester evidence",
        "Agent Card URL: " + (testerEvidenceState.agentCardUrl || "none pasted yet"),
        "Agent: " + (testerEvidenceState.agentName || "none saved yet"),
        "Decision endpoint: " + (testerEvidenceState.agentEndpoint || "none saved yet"),
        "Endpoint health: " + (testerEvidenceState.endpointHealth || "not checked yet"),
        "Job status: " + (testerEvidenceState.jobStatus || "idle"),
        "Run ID: " + (testerEvidenceState.runID || "none yet"),
        "Replay: " + absoluteEvidenceUrl(testerEvidenceState.replayPath),
        "Feedback: " + absoluteEvidenceUrl(testerEvidenceState.feedbackPath),
        "Failure summary: " + (testerEvidenceState.failureSummary || "none")
      ].join("\\n");
    }
    function updateTesterEvidenceAgentCardUrl(value) {
      const text = String(value || "").trim();
      if (text) testerEvidenceState.agentCardUrl = text;
      renderTesterEvidencePacket();
    }
    function updateTesterEvidenceAgent(nation) {
      if (!nation || typeof nation !== "object") return;
      if (typeof nation.agentName === "string" && nation.agentName.trim()) {
        testerEvidenceState.agentName = nation.agentName.trim();
      }
      const provider = nation.provider;
      if (
        provider &&
        typeof provider === "object" &&
        provider.provider === "external-http" &&
        typeof provider.endpointUrl === "string"
      ) {
        testerEvidenceState.agentEndpoint = provider.endpointUrl;
      }
      renderTesterEvidencePacket();
    }
    function updateTesterEvidenceEndpointHealth(result) {
      if (!result || typeof result !== "object") return;
      const ok = result.ok === true;
      const selected = result.selectedLegalActionId ? "; selected " + result.selectedLegalActionId : "";
      const latency = typeof result.latencyMs === "number" ? "; latency " + result.latencyMs + "ms" : "";
      const failure = result.failureReason || result.error || result.fixHint || "";
      testerEvidenceState.endpointHealth = ok
        ? "passed" + selected + latency
        : "failed" + (failure ? "; " + oneLineEvidence(failure) : "");
      renderTesterEvidencePacket();
    }
    function updateTesterEvidenceFromJob(job) {
      if (!job || typeof job !== "object") return;
      const status = typeof job.status === "string" ? job.status : "unknown";
      const jobID = typeof job.jobID === "string" ? " (" + job.jobID + ")" : "";
      testerEvidenceState.jobStatus = status + jobID;
      if (typeof job.latestRunID === "string" && job.latestRunID.trim()) {
        testerEvidenceState.runID = job.latestRunID;
        testerEvidenceState.replayPath = "/proxywar-replay/" + encodeURIComponent(job.latestRunID);
        testerEvidenceState.feedbackPath = "/runs/" + encodeURIComponent(job.latestRunID) + "/external-agent-feedback.md";
      }
      if (status === "failed") {
        testerEvidenceState.failureSummary = oneLineEvidence(job.errorSummary || "failed without a clear error");
      } else if (status === "completed") {
        testerEvidenceState.failureSummary = null;
      }
      renderTesterEvidencePacket();
    }
    function updateTesterEvidenceFailure(message) {
      testerEvidenceState.failureSummary = oneLineEvidence(message);
      renderTesterEvidencePacket();
    }
    function absoluteEvidenceUrl(value) {
      if (!value) return "none yet";
      try {
        return new URL(String(value), window.location.origin).toString();
      } catch {
        return String(value);
      }
    }
    function oneLineEvidence(value) {
      const text = String(value || "").replace(/^Error:\\s*/i, "").replace(/\\s+/g, " ").trim();
      return text.length > 240 ? text.slice(0, 237) + "..." : text;
    }
    function readChecklistState() {
      let stored = {};
      try {
        stored = JSON.parse(localStorage.getItem(firstAgentChecklistKey) || "{}") || {};
      } catch {
        stored = {};
      }
      const state = {};
      for (const step of firstAgentChecklistOrder) {
        state[step] = stored[step] === true;
      }
      for (const step of ["cardImported", "agentSaved", "firstMatchRun", "feedbackOpened"]) {
        if (firstAgentChecklistServerState[step] === true) {
          state[step] = true;
        }
      }
      return state;
    }
    function markChecklistStep(step, done = true) {
      if (!firstAgentChecklistOrder.includes(step)) return;
      firstAgentChecklistState[step] = done === true;
      try {
        localStorage.setItem(
          firstAgentChecklistKey,
          JSON.stringify(firstAgentChecklistState),
        );
      } catch {}
      renderFirstAgentChecklist();
    }
    function renderFirstAgentChecklist() {
      const firstIncomplete = firstAgentChecklistOrder.find((step) => firstAgentChecklistState[step] !== true);
      const completeCount = firstAgentChecklistOrder.filter((step) => firstAgentChecklistState[step] === true).length;
      const progress = document.getElementById("first-agent-checklist-progress");
      if (progress) {
        progress.textContent = completeCount + "/" + firstAgentChecklistOrder.length + " complete";
      }
      for (const item of document.querySelectorAll("[data-checklist-step]")) {
        const step = item.dataset.checklistStep || "";
        const done = firstAgentChecklistState[step] === true;
        const current = !done && step === firstIncomplete;
        const available = step === "feedbackOpened" && firstAgentChecklistServerState.feedbackAvailable === true;
        item.classList.toggle("done", done);
        item.classList.toggle("current", current);
        const state = item.querySelector("[data-checklist-state]");
        if (state) {
          state.className = "check-state" + (done ? " done" : current || available ? " current" : "");
          state.textContent = done ? "Done" : available ? "Available" : current ? "Next" : "Waiting";
        }
      }
    }
    function setExternalCheckStatus(value) {
      if (externalCheckOutput) externalCheckOutput.innerHTML = value;
    }
    function setEndpointHealthStatus(result) {
      updateTesterEvidenceEndpointHealth(result);
      if (!endpointHealthSummary) return;
      const ok = result && result.ok === true;
      const selected = result?.selectedLegalActionId ? " Selected " + result.selectedLegalActionId + "." : "";
      const fix = !ok && result?.fixHint ? " Fix: " + result.fixHint : "";
      const failure = !ok && result?.failureReason ? " " + result.failureReason : "";
      endpointHealthSummary.innerHTML = "<strong>Endpoint health:</strong> <span class=\\"pill " + (ok ? "good" : "bad") + "\\">" + (ok ? "passed" : "failed") + "</span> " + escapeText(selected + failure + fix) + (!ok ? endpointRecoveryHtml(failure + fix) : "");
    }
    async function startSavedRosterMatch(statusElement, button, startLabel, options) {
      if (button) button.disabled = true;
      const rosterWarning = initialSavedAgentCount === 0
        ? ""
        : "<br><span class=\\"pill\\">External agent saved</span> The latest saved tester agent enters this match with the Codex house agent.";
      setElementStatus(statusElement, "<strong>" + escapeText(startLabel) + "</strong> Running the saved tester agent plus one Codex house agent against two Easy built-in nations until a winner emerges." + rosterWarning);
      try {
        const response = await fetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(${publicCodexMatchRequestJson})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "match request failed");
        setElementStatus(statusElement, "<strong>Match queued.</strong> Job <code>" + escapeText(result.jobID) + "</code>");
        const finalJob = await pollJob(result.jobID, options);
        if (finalJob?.status === "completed") {
          markChecklistStep("firstMatchRun");
          const html = publicJobStatusHtml(finalJob, options);
          setElementStatus(statusElement, html);
          setFirstMatchStatus(html);
        }
      } catch (error) {
        updateTesterEvidenceFailure(String(error));
        setElementStatus(statusElement, "<strong>Could not start match.</strong> " + escapeText(String(error)) + endpointRecoveryHtml(String(error)) + "<div class=\\"recovery-note\\"><strong>Saved roster recovery:</strong> if this came from an old tunnel or localhost endpoint, delete the stale saved agent and import a fresh Agent Card.</div>");
      } finally {
        if (button) button.disabled = false;
      }
    }
    function setElementStatus(element, value) {
      if (element) element.innerHTML = value;
    }
    function setFirstMatchStatus(value) {
      if (firstMatchStatus) firstMatchStatus.innerHTML = value;
    }
    function setAgentCardStatus(value) {
      if (agentCardStatus) agentCardStatus.innerHTML = value;
    }
    function setStatus(value) {
      if (output) output.textContent = value;
    }
    function setStatusText(value) {
      if (output) output.innerHTML = value;
    }
    function setShowcaseStatus(value) {
      if (showcaseStatus) showcaseStatus.innerHTML = value;
    }
    function agentCardUrlRecoveryHtml(message = "") {
      const lower = String(message || "").toLowerCase();
      const endpointSpecific = lower.includes("decide") || lower.includes("health") || lower.includes("agent-card") || lower.includes("url");
      return "<ul class=\\"recovery-list\\">" +
        "<li>Paste the public <code>/agent-card.md</code> URL, not <code>/proxywar/decide</code>.</li>" +
        "<li>Inside the card, <code>endpointUrl</code> should point to <code>/proxywar/decide</code>.</li>" +
        "<li>Run <code>npm run self-test</code> before importing.</li>" +
        (endpointSpecific ? "<li>If this is a deployed agent, confirm the URL is public HTTPS and not localhost.</li>" : "") +
      "</ul>";
    }
    function endpointRecoveryHtml(message = "") {
      return "<ul class=\\"recovery-list\\">" +
        "<li>" + escapeText(endpointCoaching(message)) + "</li>" +
        "<li>Confirm <code>POST /proxywar/decide</code> returns JSON with <code>selectedLegalActionId</code>.</li>" +
        "<li>For hosted beta, use public HTTPS. Localhost and private network URLs are blocked.</li>" +
      "</ul>";
    }
    function jobRecoveryHtml(job) {
      const message = job?.errorSummary || "";
      return "<ul class=\\"recovery-list\\">" +
        "<li>" + escapeText(endpointCoaching(message)) + "</li>" +
        "<li>If the active saved agent points at an old tunnel or dead endpoint, delete it from Saved Agents and import a fresh Agent Card.</li>" +
        "<li>After fixing the endpoint, use Test Endpoint or Import Only before running again.</li>" +
      "</ul>";
    }
    async function copyText(value) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    function escapeText(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    }
  </script>
</body>
</html>`;
}

export function renderProxyWarPublicHtmlLegacy(
  model: AgentDemoHubModel,
): string {
  const latestRun = featuredRenderedRun(model.runs);
  const activeJob =
    model.jobs.find(
      (job) => job.status === "running" || job.status === "queued",
    ) ?? null;
  const savedNationCards = model.savedNations
    .map((nation) => savedNationCard(nation))
    .join("\n");
  const externalAgentCount = model.savedNations.filter(
    (nation) => nation.provider?.provider === "external-http",
  ).length;
  const queuedCount = Math.min(8, model.savedNations.length);
  const fillerCount = Math.max(0, 4 - queuedCount);
  const recentRows = model.runs
    .slice(0, 12)
    .map((run) => publicRunRow(run))
    .join("\n");
  const latestReplayLink =
    latestRun !== null && latestRun.hasOpenFrontReplay
      ? `/proxywar-replay/${encodeURIComponent(latestRun.runID)}`
      : null;
  const publicCodexMatchRequestJson = JSON.stringify({
    ...proxyWarTesterSavedRosterJobDefaults,
    brain: model.houseAgentBrain,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War</title>
  <style>
    :root { color-scheme: light; --ink:#18202b; --muted:#627084; --line:#d8e0e7; --paper:#f4f6f1; --panel:#fff; --panel-soft:#f9fbf6; --accent:#21745f; --accent-dark:#213f57; --amber:#9a6410; --red:#a43b4b; --violet:#5d5795; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; background:linear-gradient(180deg, rgba(33,116,95,.08), transparent 460px); }
    .shell { position:relative; max-width:1220px; margin:0 auto; padding:22px 24px 56px; }
    .topbar { display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:20px; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:900; letter-spacing:.02em; }
    .brand-mark { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; color:#fff; background:#203f57; box-shadow:inset 0 0 0 2px rgba(255,255,255,.18); }
    nav { display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:flex-end; }
    nav a, .link-button { display:inline-flex; align-items:center; min-height:34px; padding:7px 10px; border:1px solid var(--line); border-radius:6px; background:#fff; color:#28455d; font-weight:800; }
    .hero { display:grid; grid-template-columns:minmax(0, 1.05fr) minmax(340px, .95fr); gap:18px; align-items:stretch; margin-bottom:18px; }
    .hero-copy, .arena-preview, .panel, .stat, .flow article, .builder-path article { background:rgba(255,255,255,.94); border:1px solid var(--line); border-radius:8px; box-shadow:0 12px 34px rgba(25, 41, 55, .07); }
    .hero-copy { padding:28px; display:flex; flex-direction:column; justify-content:space-between; min-height:380px; }
    .eyebrow { color:var(--accent); font-weight:900; font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    h1 { margin:10px 0 14px; font-size:clamp(44px, 7vw, 82px); line-height:.94; letter-spacing:0; }
    .hero-copy p { max-width:700px; margin:0; color:#536174; font-size:18px; }
    .hero-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:24px; }
    .cta { display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:10px 14px; border-radius:6px; background:var(--accent); color:#fff; font-weight:900; text-decoration:none; border:1px solid transparent; }
    .cta.secondary { background:#fff; color:#24465c; border-color:var(--line); }
    .arena-preview { padding:16px; display:grid; grid-template-rows:auto 1fr auto; gap:12px; }
    .arena-head { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .map-preview { min-height:220px; display:grid; grid-template-columns:repeat(12, 1fr); grid-auto-rows:1fr; gap:4px; padding:8px; border:1px solid #cfdae2; border-radius:8px; background:#eaf0e7; }
    .tile { border-radius:4px; min-height:14px; background:#d7dfd1; }
    .tile.a { background:#5da27c; } .tile.b { background:#dfb45c; } .tile.c { background:#8794cf; } .tile.d { background:#d97170; } .tile.e { background:#7ab2bd; }
    .battle-feed { display:grid; gap:8px; }
    .feed-row { display:flex; justify-content:space-between; gap:10px; padding:9px 10px; border:1px solid #dde5ec; border-radius:6px; background:#fbfcfa; font-size:13px; }
    main { display:grid; gap:18px; }
    h2 { margin:0 0 12px; font-size:24px; letter-spacing:0; }
    h3 { margin:0 0 8px; font-size:17px; letter-spacing:0; }
    a { color:#176358; font-weight:800; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .grid { display:grid; grid-template-columns:minmax(320px, 430px) 1fr; gap:18px; align-items:start; }
    .panel { padding:18px; }
    .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; }
    .stat { padding:16px; }
    .stat span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .stat strong { display:block; font-size:28px; margin-top:4px; }
    label { display:block; color:#405166; font-weight:800; font-size:12px; margin:10px 0 5px; }
    select, input, textarea { width:100%; border:1px solid #cbd6e2; border-radius:6px; padding:10px; background:white; color:var(--ink); font:inherit; }
    textarea { min-height:96px; resize:vertical; }
    button { width:100%; border:0; border-radius:6px; padding:11px 12px; margin-top:14px; background:var(--accent); color:white; font:800 14px/1.2 inherit; cursor:pointer; }
    button.secondary { background:var(--accent-dark); }
    button.utility { background:#ecf4f2; color:#155a52; border:1px solid #b8d2cc; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#eef4f5; color:#46576c; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    .hint { color:var(--muted); font-size:13px; }
    .manifest-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; }
    .manifest-card { border:1px solid var(--line); border-radius:8px; padding:12px; background:#f9fbfd; }
    .manifest-card strong { display:block; }
    .manifest-card p { margin:5px 0 0; color:var(--muted); font-size:12px; }
    .pill { display:inline-flex; align-items:center; min-height:22px; padding:2px 8px; border-radius:999px; background:#e7f5ee; color:#1f6d4d; font-weight:800; font-size:12px; }
    .pill.warn { background:#fff6dc; color:var(--amber); }
    .pill.bad { background:#fdebf0; color:var(--red); }
    .pill.good { background:#e7f5ee; color:#1f6d4d; }
    .pill.busy { background:#e7f0ff; color:#245a96; }
    .beta-banner { display:flex; justify-content:space-between; gap:18px; align-items:center; }
    .inline-form { margin:0; }
    .inline-form button { width:auto; margin:0; padding:9px 12px; background:var(--accent-dark); }
    .job-log { white-space:pre-wrap; min-height:140px; max-height:280px; overflow:auto; background:#111b29; color:#d7e6f6; border-radius:8px; padding:12px; font:12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .inline-status { margin-top:12px; border:1px solid #c8d8e8; background:#f3f8ff; color:#214462; border-radius:8px; padding:12px; font-size:13px; }
    .inline-status strong { display:block; margin-bottom:4px; }
    .inline-status .links { margin-top:8px; }
    .inline-status pre { overflow:auto; margin:8px 0 0; padding:10px; border-radius:6px; background:#102033; color:#e8f3ff; font-size:12px; }
    .inline-status details { margin-top:8px; }
    .beta-checklist { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; margin:12px 0 0; padding:0; list-style:none; counter-reset:betaStep; }
    .beta-checklist li { counter-increment:betaStep; display:grid; grid-template-columns:28px 1fr; gap:9px; align-items:start; padding:11px; border:1px solid #d7e6df; border-radius:8px; background:#fbfefc; }
    .beta-checklist li::before { content:counter(betaStep); width:24px; height:24px; border-radius:999px; display:grid; place-items:center; background:#1f7a55; color:#fff; font-weight:900; font-size:12px; }
    .beta-checklist strong { display:block; font-size:13px; }
    .beta-checklist span { display:block; color:var(--muted); font-size:12px; margin-top:2px; }
    .protocol-card { margin-top:12px; border:1px solid #dbe5ed; border-radius:8px; background:#f8fbfd; padding:12px; }
    .protocol-card summary { cursor:pointer; font-weight:800; color:#24445f; }
    .protocol-card pre { overflow:auto; white-space:pre-wrap; margin:10px 0 0; padding:10px; border-radius:6px; background:#102033; color:#e8f3ff; font-size:12px; }
    .workbench-card { margin-top:12px; border:1px solid #dbe5ed; border-radius:8px; background:#fbfcfa; padding:12px; }
    .workbench-card h3 { margin-bottom:4px; }
    .wizard-card { margin-top:12px; border:1px solid #bfd8d0; border-radius:8px; background:#f2faf7; padding:12px; }
    .wizard-card h3 { margin-bottom:4px; }
    .wizard-steps { display:grid; gap:7px; margin:10px 0 0; padding:0; list-style:none; counter-reset:wizard; }
    .wizard-steps li { counter-increment:wizard; display:grid; grid-template-columns:28px 1fr auto; gap:8px; align-items:start; padding:9px; border:1px solid #d7e6df; border-radius:6px; background:#fff; }
    .wizard-steps li::before { content:counter(wizard); width:24px; height:24px; border-radius:999px; display:grid; place-items:center; background:#e4f1ec; color:#1c6655; font-weight:900; font-size:12px; }
    .wizard-steps strong { display:block; font-size:13px; }
    .wizard-steps small { color:var(--muted); }
    .wizard-steps .step-state { justify-self:end; white-space:nowrap; }
    .wizard-steps li.done { border-color:#93cbb5; background:#f6fcf9; }
    .wizard-steps li.done::before { background:#1f7a55; color:#fff; }
    .sandbox-grid { display:grid; grid-template-columns:2fr minmax(90px, .7fr); gap:10px; margin-top:10px; }
    .sandbox-grid button { align-self:end; margin-top:0; }
    .sample-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:10px; margin-top:10px; }
    .sample-box { border:1px solid #dce5ec; border-radius:8px; background:#fff; padding:10px; }
    .sample-box header { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:8px; }
    .sample-box strong { font-size:13px; }
    .sample-box pre { overflow:auto; white-space:pre-wrap; min-height:164px; margin:0; padding:10px; border-radius:6px; background:#102033; color:#e8f3ff; font-size:12px; }
    .copy-button { width:auto; margin:0; padding:7px 9px; background:#eef5f2; border:1px solid #bdd4cc; color:#185f52; }
    .health-check-card { display:grid; gap:8px; }
    .health-check-card .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .section { margin-top:18px; }
    .flow { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:18px; }
    .flow article { padding:14px; }
    .flow strong { display:block; margin-bottom:4px; }
    .builder-path { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:12px; margin-bottom:18px; }
    .builder-path article { padding:14px; }
    .builder-path h3 { margin-bottom:6px; }
    .builder-path code { display:block; margin-top:8px; white-space:pre-wrap; background:#102033; color:#e8f3ff; border-radius:6px; padding:10px; font-size:12px; }
    .latest-match { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:16px; align-items:center; }
    .latest-match code { display:block; margin-top:4px; color:#435167; }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:8px; background:#fff; }
    .table-wrap table { border:0; border-radius:0; }
    footer { color:var(--muted); font-size:12px; padding:4px 0 24px; }
    @media (max-width: 920px) { .hero, .grid, .latest-match { grid-template-columns:1fr; } .shell { padding:16px; } .hero-copy { min-height:auto; } .topbar { align-items:flex-start; flex-direction:column; } nav { justify-content:flex-start; } }
    @media (max-width: 620px) { .hero-actions, .links { flex-direction:column; } .cta, nav a, .link-button { width:100%; } h1 { font-size:44px; } }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">PW</span>
        <span>Proxy War</span>
        ${model.closedBeta?.enabled ? `<span class="pill warn">${escapeHtml(model.closedBeta.label)}</span>` : ""}
      </div>
      <nav aria-label="Proxy War navigation">
        ${latestReplayLink !== null ? `<a href="${latestReplayLink}" target="_blank">Latest rendered replay</a>` : ""}
        <a href="#external-agent-form">Connect agent</a>
        <a href="#queue">Roster</a>
        <a href="#recent-matches">Runs</a>
        <a href="/tester-dashboard">Tester dashboard</a>
        <a href="/docs/PROXYWAR_TESTER_HANDOFF.md" target="_blank">Tester handoff</a>
        <a href="/docs/PROXYWAR_EXTERNAL_AGENT_API.md" target="_blank">Agent API</a>
        ${model.closedBeta?.enabled ? "" : `<a href="/admin">Operator status</a>`}
      </nav>
    </header>
    <section class="hero">
      <div class="hero-copy">
        <div>
          <div class="eyebrow">Autonomous strategy league for AI builders</div>
          <h1>Build an AI nation. Watch it play Proxy War.</h1>
          <p>Configure a reference nation or connect your own agent brain, enter it into a match with Codex-powered house agents, then inspect the rendered replay and decision trail.</p>
          <div class="hero-actions">
            ${latestReplayLink !== null ? `<a class="cta" href="${latestReplayLink}" target="_blank">Watch latest rendered gameplay</a>` : `<a class="cta" href="#demo-form">Run first match</a>`}
            <a class="cta secondary" href="#external-agent-form">Connect your agent brain</a>
            <a class="cta secondary" href="https://github.com/0xNad/ProxyWar-starter-agent" target="_blank" rel="noopener noreferrer">Use starter template</a>
          </div>
        </div>
        <div class="flow" aria-label="Proxy War flow">
          <article><strong>Create</strong><span class="hint">Name a nation and choose a doctrine.</span></article>
          <article><strong>Connect</strong><span class="hint">Optionally point Proxy War at your own HTTPS agent.</span></article>
          <article><strong>Watch</strong><span class="hint">Open the rendered Proxy War replay after generation.</span></article>
          <article><strong>Improve</strong><span class="hint">Use reasons, scorecards, and timelines to tune the next entrant.</span></article>
        </div>
      </div>
      <aside class="arena-preview" aria-label="Proxy War match preview">
        <div class="arena-head">
          <div>
            <strong>Latest Arena State</strong>
            <div class="hint">${latestRun ? escapeHtml(latestRun.runID) : "No rendered match yet"}</div>
          </div>
          <span class="pill good">LegalAction.id only</span>
        </div>
        <div class="map-preview" aria-hidden="true">
          ${renderArenaTiles()}
        </div>
        <div class="battle-feed">
          <div class="feed-row"><span>Agents queued</span><strong>${queuedCount}</strong></div>
          <div class="feed-row"><span>External brains</span><strong>${externalAgentCount}</strong></div>
          <div class="feed-row"><span>Latest non-hold</span><strong>${numberCell(latestRun?.postSpawnNonHoldActionCount)}</strong></div>
        </div>
      </aside>
    </section>
  <main>
    ${
      model.closedBeta?.enabled
        ? `<section class="panel beta-banner" style="margin-bottom:18px">
            <div>
              <h2>${escapeHtml(model.closedBeta.label)} Build</h2>
              <p class="hint">Invite-only Codex demo. Create a safe manifest-only nation, run a Codex-planned saved-nations match, then watch the rendered replay.</p>
            </div>
            <form class="inline-form" method="post" action="/api/beta/logout">
              <button type="submit">Sign out</button>
            </form>
          </section>`
        : ""
    }
    <section class="panel" id="beta-checklist" aria-label="Beta test checklist">
      <h2>Beta Test Golden Path</h2>
      <p class="hint">For a first tester, follow this path in order. Every step should either work or show a useful fix-it message.</p>
      <ol class="beta-checklist">
        <li><div><strong>Watch the latest replay</strong><span>Confirms the renderer, replay route, speed controls, and decision overlay work.</span></div></li>
        <li><div><strong>Copy the LLM starter agent</strong><span>Use the one-click command or starter server code below.</span></div></li>
        <li><div><strong>Test endpoint</strong><span>The health check proves strict LegalAction.id JSON before a match.</span></div></li>
        <li><div><strong>Save agent</strong><span>Keeps the endpoint available for protocol checks and future external-agent runs.</span></div></li>
        <li><div><strong>Run first match</strong><span>Proxy War runs your saved external agent with one Codex agent against two Easy built-in nations and opens the rendered replay when ready.</span></div></li>
        <li><div><strong>Send feedback</strong><span>Include the run id if anything is confusing, broken, or surprisingly fun.</span></div></li>
      </ol>
    </section>
    <section class="stat-grid" aria-label="Proxy War run metrics">
      <div class="stat"><span>Matches</span><strong>${model.runs.length}</strong></div>
      <div class="stat"><span>Accepted Decisions</span><strong>${sum(model.runs, "acceptedCount")}</strong></div>
      <div class="stat"><span>Non-hold Actions</span><strong>${sum(model.runs, "postSpawnNonHoldActionCount")}</strong></div>
      <div class="stat"><span>Queued Entrants</span><strong>${queuedCount}</strong></div>
      <div class="stat"><span>External Agents</span><strong>${externalAgentCount}</strong></div>
    </section>
    <section class="builder-path" aria-label="Builder quick start">
      <article>
        <h3>Fast path: configure a reference nation</h3>
        <p class="hint">No code required. Choose doctrine, profile, and skill preferences. Proxy War runs the local planner/executor for you.</p>
      </article>
      <article>
        <h3>Builder path: connect your own agent brain</h3>
        <p class="hint">Run an HTTPS service that receives observations plus legal action ids and returns one <code style="display:inline;padding:0;background:transparent;color:inherit">selectedLegalActionId</code>.</p>
        <div class="links">
          <a href="/docs/PROXYWAR_TESTER_HANDOFF.md" target="_blank">Tester handoff</a>
          <a href="/docs/PROXYWAR_EXTERNAL_AGENT_API.md" target="_blank">Agent API</a>
          <a href="https://github.com/0xNad/ProxyWar-starter-agent" target="_blank" rel="noopener noreferrer">GitHub template</a>
          <a href="/examples/external-agent/README.md" target="_blank">Example README</a>
          <a href="/examples/external-agent/simple-agent.mjs" target="_blank">simple-agent.mjs</a>
          <a href="/examples/external-agent/AGENT_SKILL.md" target="_blank">Agent skill prompt</a>
        </div>
      </article>
      <article>
        <h3>Local smoke test</h3>
        <p class="hint">From the repo root, this starts the LLM example agent, checks the endpoint, runs a match, and writes feedback artifacts.</p>
        <code>OPENROUTER_API_KEY="paste-your-openrouter-key" npm run agent:external-agent:dry-run</code>
      </article>
    </section>
    ${
      activeJob
        ? `<section id="active-job-banner" class="panel" style="margin-bottom:18px">
            <h2>Match Generation In Progress</h2>
            <p><span class="pill busy">${escapeHtml(activeJob.status)}</span> ${escapeHtml(activeJob.label)}</p>
            <p class="hint">Codex matches can take several minutes. Keep this page open; it will update and open the rendered replay when the job finishes.</p>
            <div id="active-job-status" class="inline-status">Checking job status...</div>
          </section>`
        : ""
    }
    ${
      latestRun
        ? `<section class="panel latest-match" style="margin-bottom:18px">
            <div>
              <h2>Watch Latest Rendered Gameplay</h2>
              <p class="hint">Open the native rendered replay first, then use reports to understand why agents acted.</p>
              <code>${escapeHtml(latestRun.runID)}</code>
            </div>
            <div class="links">
              ${latestRun.hasOpenFrontReplay ? `<a class="cta" href="/proxywar-replay/${encodeURIComponent(latestRun.runID)}" target="_blank">Watch rendered gameplay</a>` : ""}
              ${latestRun.hasMatchPackage ? `<a class="cta secondary" href="/runs/${encodeURIComponent(latestRun.runID)}/${latestRun.matchPackageLinkFileName}">Match package</a>` : ""}
              <a class="cta secondary" href="/runs/${encodeURIComponent(latestRun.runID)}/visual-report.html">Decision report</a>
              ${latestRun.hasSpectatorReplay ? `<a class="cta secondary" href="/runs/${encodeURIComponent(latestRun.runID)}/spectator.html">Replay timeline</a>` : ""}
              ${latestRun.hasScorecard ? `<a class="cta secondary" href="/runs/${encodeURIComponent(latestRun.runID)}/objective-scorecard.md">Scorecard</a>` : ""}
            </div>
          </section>`
        : ""
    }
    <section class="grid">
      <aside class="panel">
        <form id="nation-form">
          <h2>Configure Reference Nation</h2>
          <p class="hint">No-code manifest setup. Proxy War runs this nation with the local planner/executor; this is not your external model.</p>
          <label for="agentName">Nation name</label>
          <input id="agentName" name="agentName" type="text" maxlength="60" value="Iron Coast">
          <label for="profile">Profile</label>
          <select id="profile" name="profile">
            <option value="aggressive">Aggressive</option>
            <option value="defensive">Defensive</option>
            <option value="diplomatic">Diplomatic</option>
            <option value="opportunistic">Opportunistic</option>
          </select>
          <label for="doctrine">Doctrine</label>
          <select id="doctrine" name="doctrine">
            <option value="balanced">Balanced</option>
            <option value="economic">Economic growth</option>
            <option value="fortress">Fortress defense</option>
            <option value="diplomatic">Alliance network</option>
            <option value="pressure">Pressure rivals</option>
          </select>
          <label for="personality">Doctrine note</label>
          <input id="personality" name="personality" type="text" maxlength="240" value="Build a strong economy, avoid bad wars, and expand when the border is safe.">
          <button type="submit">Save Reference Nation</button>
        </form>
        <form id="external-agent-form" class="section">
          <h2>Connect Your Agent Brain</h2>
          <p class="hint">Private v1 endpoint mode: your service receives one observation plus legal action ids, then returns strict JSON with selectedLegalActionId. It never sends raw game intents.</p>
          <input type="hidden" name="agentMode" value="external-http">
          <label for="externalAgentName">Nation name</label>
          <input id="externalAgentName" name="agentName" type="text" maxlength="60" value="Remote Frontier">
          <label for="externalProfile">Profile</label>
          <select id="externalProfile" name="profile">
            <option value="aggressive">Aggressive</option>
            <option value="defensive">Defensive</option>
            <option value="diplomatic">Diplomatic</option>
            <option value="opportunistic">Opportunistic</option>
          </select>
          <input type="hidden" name="doctrine" value="balanced">
          <label for="endpointUrl">Agent endpoint URL</label>
          <input id="endpointUrl" name="endpointUrl" type="url" placeholder="https://example.com/proxywar/decide">
          <label for="endpointToken">Bearer token (optional)</label>
          <input id="endpointToken" name="endpointToken" type="password" maxlength="512" autocomplete="off" placeholder="Paste a beta-only endpoint token">
          <p class="hint">Public forms do not resolve server env or secret references. Operator manifests may use tokenEnv separately.</p>
          <label for="endpointTimeoutMs">Decision timeout ms</label>
          <input id="endpointTimeoutMs" name="endpointTimeoutMs" type="number" min="250" max="180000" value="120000">
          <label for="externalPersonality">Agent note</label>
          <input id="externalPersonality" name="personality" type="text" maxlength="240" value="External endpoint controls decisions through the LegalAction.id contract.">
          <section class="wizard-card" aria-label="External agent first-match wizard">
            <h3>External Agent First-Match Wizard</h3>
            <p class="hint">A five-minute path for a developer friend: copy, run, test, save, then watch the rendered match and feedback.</p>
            <ol class="wizard-steps">
              <li class="done" data-wizard-step="copy">
                <span><strong>Copy LLM starter</strong><small>Use the starter server and skill prompt below.</small></span>
                <span class="pill good step-state">ready</span>
              </li>
              <li data-wizard-step="run">
                <span><strong>Run endpoint</strong><small>Start locally for development or deploy an HTTPS endpoint for shared beta.</small></span>
                <span class="pill warn step-state">you run it</span>
              </li>
              <li data-wizard-step="test">
                <span><strong>Test endpoint</strong><small>Must return one offered LegalAction.id before saving.</small></span>
                <span id="wizard-test-state" class="pill warn step-state">not tested</span>
              </li>
              <li data-wizard-step="save">
                <span><strong>Save agent</strong><small>Keeps this external brain available for protocol checks and future external-agent runs.</small></span>
                <span id="wizard-save-state" class="pill warn step-state">not saved</span>
              </li>
              <li data-wizard-step="match">
                <span><strong>Run first match</strong><small>Runs your saved external agent with one Codex agent against two Easy built-in nations.</small></span>
                <span id="wizard-match-state" class="pill warn step-state">waiting</span>
              </li>
            </ol>
            <button id="run-external-match" class="utility" type="button">Run First Beta Match</button>
            <div id="first-match-status" class="inline-status">
              <strong>First-match path ready.</strong>
              Test and save the endpoint, then run the locked beta match from here.
            </div>
            <div id="external-agent-feedback-preview" class="inline-status">
              <strong>Feedback preview appears after a match.</strong>
              It will show whether the external agent made accepted non-hold decisions and whether parser/fallback errors occurred.
            </div>
            <details class="protocol-card">
              <summary>Replay Sandbox</summary>
              <p class="hint">Re-test your endpoint against one saved decision menu without running a full match. This never submits a game intent.</p>
              <div class="sandbox-grid">
                <label for="sandboxRunID">Run id
                  <input id="sandboxRunID" name="sandboxRunID" type="text" maxlength="180" value="${latestRun ? escapeAttribute(latestRun.runID) : ""}" placeholder="Paste run id">
                </label>
                <label for="sandboxSequence">Decision #
                  <input id="sandboxSequence" name="sandboxSequence" type="number" min="1" max="1000000" value="11">
                </label>
              </div>
              <button id="replay-sandbox-decision" class="utility" type="button">Replay Decision Against Endpoint</button>
              <div id="replay-sandbox-output" class="inline-status">
                <strong>Sandbox not run.</strong>
                Use a weak turn from Iteration Coach, then see whether your edited policy picks a different valid LegalAction.id.
              </div>
            </details>
          </section>
          <section class="workbench-card" aria-label="Agent workbench">
            <h3>Agent Workbench</h3>
            <p class="hint">Build against this contract first. Your service receives observations and legal action ids; it returns one selected id.</p>
            <div class="sample-grid">
              <div class="sample-box">
                <header>
                  <strong>1. Copy local run command</strong>
                  <button class="copy-button" type="button" data-copy-target="starter-agent-run-command">Copy</button>
                </header>
                <p class="hint">Paste into a terminal, then choose Codex CLI, Claude/Cowork, a command, or OpenRouter with an API key. The GitHub template path adds <code>npm run self-test</code> before import.</p>
                <pre id="starter-agent-run-command">${escapeHtml(starterAgentRunCommand)}</pre>
              </div>
              <div class="sample-box">
                <header>
                  <strong>2. Copy starter source</strong>
                  <button class="copy-button" type="button" data-copy-target="starter-agent-server">Copy</button>
                </header>
                <p class="hint">Use this if you want to edit the starter before running it.</p>
                <pre id="starter-agent-server">${escapeHtml(starterAgentServerCode)}</pre>
              </div>
              <div class="sample-box">
                <header>
                  <strong>3. Copy skill prompt</strong>
                  <button class="copy-button" type="button" data-copy-target="starter-agent-skill">Copy</button>
                </header>
                <p class="hint">Paste into your agent system prompt or policy notes.</p>
                <pre id="starter-agent-skill">${escapeHtml(starterAgentSkillPrompt)}</pre>
              </div>
              <div class="sample-box">
                <header>
                  <strong>4. Sample request</strong>
                  <button class="copy-button" type="button" data-copy-target="sample-agent-request">Copy</button>
                </header>
                <pre id="sample-agent-request">{
  "protocolVersion": "proxywar-agent-v1",
  "agent": {
    "username": "Remote Frontier",
    "profile": "opportunistic"
  },
  "match": {
    "phase": "active",
    "turnNumber": 12,
    "tick": 920
  },
  "observation": {
    "summary": "You have neutral land available and no border threat."
  },
  "legalActions": [
    {
      "id": "expand:terra-nullius:10",
      "kind": "attack",
      "label": "Expand into neutral land with 10% troops"
    },
    {
      "id": "build:City:299420",
      "kind": "build",
      "label": "Build City at a safe economic tile"
    },
    {
      "id": "hold",
      "kind": "hold",
      "label": "Hold"
    }
  ]
}</pre>
              </div>
              <div class="sample-box">
                <header>
                  <strong>5. Required response</strong>
                  <button class="copy-button" type="button" data-copy-target="sample-agent-response">Copy</button>
                </header>
                <pre id="sample-agent-response">{
  "selectedLegalActionId": "build:City:299420",
  "reason": "After initial expansion, a City improves economy without overcommitting troops.",
  "confidence": 0.72
}</pre>
              </div>
            </div>
            <p class="hint">Flow: start the agent, pass the starter self-test or Test Endpoint check, save the external agent, then run a Codex match.</p>
          </section>
          <details class="protocol-card" open>
            <summary>Endpoint health-check contract</summary>
            <p class="hint">The test sends a synthetic observation with exactly two legal action ids. Your endpoint must choose one of them and return strict JSON.</p>
            <pre>{
  "legalActionIds": ["health-check:expand", "health-check:hold"],
  "expectedResponse": {
    "selectedLegalActionId": "health-check:expand",
    "reason": "Short factual reason.",
    "confidence": 0.7
  }
}</pre>
          </details>
          <button id="test-external-agent" class="utility" type="button">Test Endpoint</button>
          <button class="secondary" type="submit">Save External Agent</button>
          <div id="external-agent-check-output" class="inline-status">
            <strong>Endpoint check not run.</strong>
            Use this before saving so protocol errors are caught outside a real match.
          </div>
          <p class="hint">Need a starter? Open <a href="/examples/external-agent/README.md" target="_blank">the example agent README</a> or copy <a href="/examples/external-agent/AGENT_SKILL.md" target="_blank">the agent skill prompt</a>.</p>
        </form>
        <form id="demo-form" class="section">
          <h2>Run Codex Strategy Match</h2>
          <input type="hidden" name="kind" value="demo">
          <input type="hidden" name="brain" value="planner-codex-cli">
          <input type="hidden" name="scenario" value="actions">
          <input type="hidden" name="matchLength" value="full">
          <input type="hidden" name="roster" value="saved">
          <input type="hidden" name="maxSavedNations" value="1">
          <input type="hidden" name="fillSavedRoster" value="false">
          <input type="hidden" name="agents" value="1">
          <input type="hidden" name="maxSteps" value="700">
          <input type="hidden" name="requireWinner" value="true">
          <input type="hidden" name="bots" value="0">
          <input type="hidden" name="nations" value="2">
          <input type="hidden" name="difficulty" value="Easy">
          <p class="hint">The locked beta default is the latest saved tester agent plus one Codex-backed in-house agent against two Easy built-in nations until a winner emerges. The rendered replay opens automatically when generation finishes.</p>
          <button class="secondary" type="submit">Run Codex Match</button>
          <div id="demo-status" class="inline-status">
            <strong>Ready.</strong>
            Press once, then wait here. The default beta run is locked to the saved tester agent, one Codex agent, and two Easy built-in nations; repeated clicks queue extra matches.
          </div>
          <p class="hint">House agents in this beta are Codex-backed; failed Codex setup should fail loudly instead of falling back to a local bot.</p>
        </form>
        ${
          model.closedBeta?.enabled
            ? `<form id="feedback-form" class="section">
                <h2>Send Feedback</h2>
                <p class="hint">Tell us what was confusing, exciting, broken, or worth improving before the next invite wave.</p>
                <label for="testerName">Your name</label>
                <input id="testerName" name="testerName" type="text" maxlength="80" placeholder="Optional">
                <label for="rating">How did this feel?</label>
                <select id="rating" name="rating">
                  <option value="great">Great</option>
                  <option value="okay">Okay</option>
                  <option value="confusing">Confusing</option>
                  <option value="broken">Broken</option>
                </select>
                <label for="runID">Match/run id</label>
                <input id="runID" name="runID" type="text" maxlength="160" value="${latestRun ? escapeAttribute(latestRun.runID) : ""}" placeholder="Optional">
                <label for="comment">Notes</label>
                <textarea id="comment" name="comment" maxlength="2000" placeholder="What happened? What should be clearer?"></textarea>
                <button class="secondary" type="submit">Send Feedback</button>
              </form>`
            : ""
        }
      </aside>
      <section id="queue" class="panel">
        <h2>Next Match Queue</h2>
          <p class="hint">Saved entrants are queued locally. The tester-facing run uses the latest saved nation after an endpoint health check; curated defaults fill the empty slots.</p>
        ${
          fillerCount > 0
            ? `<p><span class="pill warn">${fillerCount} curated default${fillerCount === 1 ? "" : "s"} will fill this roster</span></p>`
            : `<p><span class="pill good">Roster has enough saved entrants</span></p>`
        }
        ${
          model.savedNations.length === 0
            ? '<p class="hint">No saved nations yet. Create one to enter it into the next match.</p>'
            : `<div class="manifest-grid">${savedNationCards}</div>`
        }
        <div class="section">
          <h3>Output</h3>
          <div id="job-output" class="job-log">Ready.</div>
        </div>
      </section>
    </section>
    <section id="recent-matches" class="section">
      <h2>Recent Matches</h2>
      ${
        model.runs.length === 0
          ? '<p class="hint">No matches yet.</p>'
          : `<div class="table-wrap"><table>
              <thead><tr><th>Match</th><th>Brain</th><th>Decisions</th><th>Non-hold</th><th>Links</th></tr></thead>
              <tbody>${recentRows}</tbody>
            </table></div>`
      }
    </section>
  </main>
  <footer>
    Proxy War is built for autonomous-agent matches. Source, license, asset credits, and beta notes are kept in the repository docs: <code>LICENSE</code>, <code>LICENSE-ASSETS</code>, <code>CREDITS.md</code>, and <code>docs/PROXYWAR_ASSET_AND_LICENSE_AUDIT.md</code>.
  </footer>
  </div>
  <script>
    const output = document.getElementById("job-output");
    const demoStatus = document.getElementById("demo-status");
    const activeJobStatus = document.getElementById("active-job-status");
    const runExternalMatchButton = document.getElementById("run-external-match");
    const replaySandboxButton = document.getElementById("replay-sandbox-decision");
    const firstMatchStatus = document.getElementById("first-match-status");
    const externalFeedbackPreview = document.getElementById("external-agent-feedback-preview");
    const replaySandboxOutput = document.getElementById("replay-sandbox-output");
    const wizardTestState = document.getElementById("wizard-test-state");
    const wizardSaveState = document.getElementById("wizard-save-state");
    const wizardMatchState = document.getElementById("wizard-match-state");
    const initialActiveJobID = ${activeJob ? JSON.stringify(activeJob.jobID) : "null"};
    for (const form of [document.getElementById("nation-form"), document.getElementById("external-agent-form"), document.getElementById("demo-form"), document.getElementById("feedback-form")].filter(Boolean)) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        setStatus("Working...");
        try {
          const body = Object.fromEntries(new FormData(form).entries());
          const endpoint = form.id === "nation-form" || form.id === "external-agent-form" ? "/api/nations" : form.id === "feedback-form" ? "/api/beta/feedback" : "/api/jobs";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "request failed");
          if (endpoint === "/api/nations") {
            setStatus("Saved nation: " + result.nation.agentName + "\\nActive roster size: " + result.activeRosterCount + "\\nRefresh to see it in the roster.");
            if (form.id === "external-agent-form") {
              setWizardState(wizardSaveState, "saved", "good");
              setFirstMatchStatus('<strong>External agent saved.</strong><span class="hint">Now run the first external-agent match. Saved external agents are entered before curated defaults.</span>');
            }
          } else if (endpoint === "/api/beta/feedback") {
            setStatus("Thanks. Feedback recorded: " + result.feedbackID);
          } else {
            setDemoStatus('<strong>Match request accepted.</strong><span class="pill busy">' + escapeText(result.status || "queued") + '</span> Job <code>' + escapeText(result.jobID) + '</code><br><span class="hint">Codex is thinking. This page will update automatically and open the rendered match when ready.</span>');
            document.getElementById("job-output")?.scrollIntoView({ block: "center", behavior: "smooth" });
            const finalJob = await pollJob(result.jobID);
            if (finalJob?.latestRunID) await loadExternalFeedback(finalJob.latestRunID);
          }
        } catch (error) {
          setStatus(String(error));
          setDemoStatus('<strong>Request failed.</strong>' + escapeText(String(error)));
        } finally {
          button.disabled = false;
        }
      });
    }
    const testExternalButton = document.getElementById("test-external-agent");
    const externalAgentForm = document.getElementById("external-agent-form");
    const externalCheckOutput = document.getElementById("external-agent-check-output");
    for (const copyButton of document.querySelectorAll("[data-copy-target]")) {
      copyButton.addEventListener("click", async () => {
        const target = document.getElementById(copyButton.dataset.copyTarget || "");
        if (!target) return;
        const original = copyButton.textContent || "Copy";
        try {
          await copyText(target.textContent || "");
          copyButton.textContent = "Copied";
          setTimeout(() => {
            copyButton.textContent = original;
          }, 1400);
        } catch (error) {
          copyButton.textContent = "Copy failed";
          setTimeout(() => {
            copyButton.textContent = original;
          }, 1800);
        }
      });
    }
    if (testExternalButton && externalAgentForm) {
      testExternalButton.addEventListener("click", async () => {
        testExternalButton.disabled = true;
        setStatus("Testing external agent endpoint...");
        setExternalCheckStatus('<strong>Endpoint health check running...</strong><span class="hint">Waiting for strict JSON with one offered LegalAction.id.</span>');
        try {
          const body = Object.fromEntries(new FormData(externalAgentForm).entries());
        const response = await fetch("/api/external-agents/check", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const result = await response.json();
          setExternalCheckStatus(externalHealthCheckHtml(result));
          if (result.ok) {
            setWizardState(wizardTestState, "passed", "good");
            setFirstMatchStatus('<strong>Endpoint passed.</strong><span class="hint">Save this external agent; the default beta match runs it with one Codex agent versus two Easy built-in nations.</span>');
            setStatus([
              "Endpoint health check: passed",
              "Selected: " + result.selectedLegalActionId,
              "Reason: " + result.reason,
              "Latency: " + result.latencyMs + "ms"
            ].join("\\n"));
          } else {
            setWizardState(wizardTestState, "failed", "bad");
            setFirstMatchStatus('<strong>Endpoint needs a fix.</strong><span class="hint">' + endpointCoaching(result?.failureReason || result?.error || "") + '</span>');
            setStatus([
              "Endpoint health check: failed",
              result.failureReason || result.error || "No clear failure reason.",
              result.rawOutput ? "Raw output: " + result.rawOutput : ""
            ].filter(Boolean).join("\\n"));
          }
        } catch (error) {
          setWizardState(wizardTestState, "failed", "bad");
          setStatus(String(error));
          setExternalCheckStatus('<strong class="pill bad">Endpoint check failed</strong> ' + escapeText(String(error)));
          setFirstMatchStatus('<strong>Endpoint check failed.</strong><span class="hint">' + endpointCoaching(String(error)) + '</span>');
        } finally {
          testExternalButton.disabled = false;
        }
      });
    }
    if (runExternalMatchButton) {
      runExternalMatchButton.addEventListener("click", async () => {
        runExternalMatchButton.disabled = true;
        setWizardState(wizardMatchState, "queued", "busy");
        setFirstMatchStatus('<strong>Starting Codex match...</strong><span class="hint">The locked beta default is the saved tester agent plus one Codex agent against two Easy built-in nations until a winner emerges.</span>');
        try {
          const response = await fetch("/api/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "demo",
              brain: ${JSON.stringify(model.houseAgentBrain)},
              scenario: "actions",
              ...${publicCodexMatchRequestJson}
            })
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "match request failed");
          setWizardState(wizardMatchState, result.status || "queued", "busy");
          setFirstMatchStatus('<strong>Match queued.</strong><span class="pill busy">' + escapeText(result.status || "queued") + '</span> Job <code>' + escapeText(result.jobID) + '</code>');
          setDemoStatus('<strong>External-agent match request accepted.</strong><span class="pill busy">' + escapeText(result.status || "queued") + '</span> Job <code>' + escapeText(result.jobID) + '</code>');
          const finalJob = await pollJob(result.jobID);
          if (finalJob?.status === "completed") {
            setWizardState(wizardMatchState, "replay ready", "good");
            setFirstMatchStatus(publicJobStatusHtml(finalJob));
            if (finalJob.latestRunID) await loadExternalFeedback(finalJob.latestRunID);
          } else if (finalJob?.status === "failed") {
            setWizardState(wizardMatchState, "failed", "bad");
            setFirstMatchStatus(publicJobStatusHtml(finalJob));
          }
        } catch (error) {
          setWizardState(wizardMatchState, "failed", "bad");
          setFirstMatchStatus('<strong>Could not start match.</strong><span class="hint">' + escapeText(String(error)) + '</span>');
        } finally {
          runExternalMatchButton.disabled = false;
        }
      });
    }
    if (replaySandboxButton && externalAgentForm) {
      replaySandboxButton.addEventListener("click", async () => {
        replaySandboxButton.disabled = true;
        setReplaySandboxStatus('<strong>Replaying saved decision...</strong><span class="hint">Calling endpoint with the saved legal action menu. No intent will be submitted.</span>');
        try {
          const body = Object.fromEntries(new FormData(externalAgentForm).entries());
          body.runID = document.getElementById("sandboxRunID")?.value || "";
          body.sequence = document.getElementById("sandboxSequence")?.value || "";
          const response = await fetch("/api/external-agents/replay-decision", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const result = await response.json();
          setReplaySandboxStatus(replaySandboxHtml(result));
          if (!response.ok) {
            setStatus([
              "Replay sandbox failed",
              result.failureReason || result.error || "No clear failure reason.",
              result.rawOutput ? "Raw output: " + result.rawOutput : ""
            ].filter(Boolean).join("\\n"));
          } else {
            setStatus([
              "Replay sandbox passed",
              "Original: " + result.originalSelectedLegalActionId,
              "New: " + result.selectedLegalActionId,
              "Changed: " + String(result.changedSelection)
            ].join("\\n"));
          }
        } catch (error) {
          setReplaySandboxStatus('<strong class="pill bad">Replay sandbox failed</strong> ' + escapeText(String(error)));
          setStatus(String(error));
        } finally {
          replaySandboxButton.disabled = false;
        }
      });
    }
    function setExternalCheckStatus(value) {
      if (!externalCheckOutput) return;
      externalCheckOutput.innerHTML = value;
    }
    function externalHealthCheckHtml(result) {
      const ok = result && result.ok === true;
      const offered = Array.isArray(result?.offeredLegalActionIDs)
        ? result.offeredLegalActionIDs
        : ["health-check:expand", "health-check:hold"];
      const offeredHtml = offered.map((id) => '<code>' + escapeText(id) + '</code>').join(" ");
      const rows = [
        '<div class="row"><span class="pill ' + (ok ? 'good' : 'bad') + '">' + (ok ? 'Passed' : 'Failed') + '</span>' +
          (result?.latencyMs !== undefined ? '<span>Latency: ' + escapeText(result.latencyMs) + 'ms</span>' : '') + '</div>',
        ok ? '<div><strong>Next step</strong><br>Save this external agent, then run a Codex strategy match.</div>' : "",
        '<div><strong>Offered legal ids</strong><br>' + offeredHtml + '</div>',
        result?.selectedLegalActionId ? '<div><strong>Selected</strong><br><code>' + escapeText(result.selectedLegalActionId) + '</code></div>' : "",
        result?.reason ? '<div><strong>Reason</strong><br>' + escapeText(result.reason) + '</div>' : "",
        result?.confidence !== undefined ? '<div><strong>Confidence</strong><br>' + escapeText(result.confidence) + '</div>' : "",
        !ok ? '<div><strong>Failure</strong><br>' + escapeText(result?.failureReason || result?.error || "No clear failure reason.") + '</div>' : "",
        result?.fixHint ? '<div><strong>Fix</strong><br>' + escapeText(result.fixHint) + '</div>' : "",
        result?.request?.method ? '<div><strong>Check sent</strong><br><code>' + escapeText(result.request.method + ' ' + (result.endpoint || '')) + '</code></div>' : ""
      ].filter(Boolean);
      const raw = result?.rawOutput
        ? '<details><summary>Raw endpoint output</summary><pre>' + escapeText(result.rawOutput) + '</pre></details>'
        : "";
      return '<div class="health-check-card">' + rows.join("") + raw + '</div>';
    }
    async function copyText(value) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    async function pollJob(jobID) {
      while (true) {
        const response = await fetch("/api/jobs/" + encodeURIComponent(jobID));
        const job = await response.json();
        const html = publicJobStatusHtml(job);
        output.innerHTML = html;
        setDemoStatus(html);
        if (activeJobStatus) activeJobStatus.innerHTML = html;
        if (job.status === "completed" || job.status === "failed") return job;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    if (initialActiveJobID) {
      pollJob(initialActiveJobID).catch((error) => {
        if (activeJobStatus) activeJobStatus.textContent = String(error);
      });
    }
    function setStatus(value) {
      if (!output) return;
      output.textContent = value;
    }
    function setDemoStatus(value) {
      if (!demoStatus) return;
      demoStatus.innerHTML = value;
    }
    function setFirstMatchStatus(value) {
      if (!firstMatchStatus) return;
      firstMatchStatus.innerHTML = value;
    }
    function setReplaySandboxStatus(value) {
      if (!replaySandboxOutput) return;
      replaySandboxOutput.innerHTML = value;
    }
    function setWizardState(element, label, tone) {
      if (!element) return;
      element.textContent = label;
      element.className = "pill step-state " + (tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "busy" ? "busy" : "warn");
      const step = element.closest("[data-wizard-step]");
      if (step && tone === "good") step.classList.add("done");
    }
    async function loadExternalFeedback(runID) {
      if (!externalFeedbackPreview) return;
      try {
        const response = await fetch("/runs/" + encodeURIComponent(runID) + "/external-agent-feedback.md");
        if (!response.ok) {
          externalFeedbackPreview.innerHTML = '<strong>Feedback artifact not found yet.</strong><span class="hint">Open the decision report if this was a local reference-only match.</span>';
          return;
        }
        const text = await response.text();
        const summary = summarizeFeedbackMarkdown(text);
        externalFeedbackPreview.innerHTML = [
          '<strong>External-agent feedback ready.</strong>',
          '<div class="links"><a href="/runs/' + encodeURIComponent(runID) + '/external-agent-feedback.md" target="_blank">Open full feedback</a><a href="/runs/' + encodeURIComponent(runID) + '/visual-report.html" target="_blank">Decision report</a></div>',
          '<pre>' + escapeText(summary) + '</pre>'
        ].join("");
      } catch (error) {
        externalFeedbackPreview.innerHTML = '<strong>Feedback preview failed.</strong><span class="hint">' + escapeText(String(error)) + '</span>';
      }
    }
    function summarizeFeedbackMarkdown(text) {
      const useful = text
        .split("\\n")
        .filter((line) =>
          line.startsWith("- External agents:") ||
          line.startsWith("- Decisions:") ||
          line.startsWith("- Accepted:") ||
          line.startsWith("- Rejected:") ||
          line.startsWith("- Fallbacks:") ||
          line.startsWith("- Parser failures:") ||
          line.startsWith("- Post-spawn non-hold rate:") ||
          line.startsWith("- Ready for developer review:") ||
          line.startsWith("- Status:") ||
          line.startsWith("- Turn ") ||
          line.startsWith("- Fix") ||
          line.startsWith("- Break") ||
          line.startsWith("- Keep") ||
          line.startsWith("- Add") ||
          line.startsWith("- If observation.memory") ||
          line.startsWith("- After two safe expansions") ||
          line.startsWith("- Choose Defense Post") ||
          line.startsWith("- Before selecting strategy")
        )
        .slice(0, 14);
      return useful.length > 0 ? useful.join("\\n") : text.slice(0, 1200);
    }
    function endpointCoaching(message) {
      const lower = String(message || "").toLowerCase();
      if (lower.includes("unknown") || lower.includes("legalaction")) {
        return "Return exactly one id from the offered legalActions array. Do not invent action ids.";
      }
      if (lower.includes("json") || lower.includes("parse") || lower.includes("malformed")) {
        return "Return strict JSON only: selectedLegalActionId, reason, and optional confidence.";
      }
      if (lower.includes("timeout") || lower.includes("abort")) {
        return "The endpoint was too slow. Reduce model/tool work or increase the timeout for private tests.";
      }
      if (lower.includes("private") || lower.includes("https")) {
        return "Shared beta endpoints must be public HTTPS. Localhost is only allowed when the host enables local private endpoints.";
      }
      return "Check that your endpoint accepts POST /proxywar/decide and returns the strict LegalAction.id JSON contract.";
    }
    function replaySandboxHtml(result) {
      const ok = result && result.ok === true;
      const offered = Array.isArray(result?.offeredLegalActionIDs)
        ? result.offeredLegalActionIDs.slice(0, 12)
        : [];
      return [
        '<div class="health-check-card">',
        '<div class="row"><span class="pill ' + (ok ? 'good' : 'bad') + '">' + (ok ? 'Valid replay decision' : 'Replay failed') + '</span>' +
          (result?.latencyMs !== undefined ? '<span>Latency: ' + escapeText(result.latencyMs) + 'ms</span>' : '') + '</div>',
        result?.observationSummary ? '<div><strong>Saved observation</strong><br>' + escapeText(result.observationSummary) + '</div>' : '',
        result?.originalSelectedLegalActionId ? '<div><strong>Original selected id</strong><br><code>' + escapeText(result.originalSelectedLegalActionId) + '</code></div>' : '',
        result?.selectedLegalActionId ? '<div><strong>Endpoint now selected</strong><br><code>' + escapeText(result.selectedLegalActionId) + '</code></div>' : '',
        result?.changedSelection !== undefined ? '<div><strong>Changed selection</strong><br>' + (result.changedSelection ? 'yes' : 'no') + '</div>' : '',
        result?.reason ? '<div><strong>Reason</strong><br>' + escapeText(result.reason) + '</div>' : '',
        result?.coaching ? '<div><strong>Coach</strong><br>' + escapeText(result.coaching) + '</div>' : '',
        !ok ? '<div><strong>Failure</strong><br>' + escapeText(result?.failureReason || result?.error || 'No clear failure reason.') + '</div>' : '',
        offered.length > 0 ? '<details><summary>Offered ids</summary><pre>' + escapeText(offered.join("\\n")) + '</pre></details>' : '',
        result?.rawOutput ? '<details><summary>Raw endpoint output</summary><pre>' + escapeText(result.rawOutput) + '</pre></details>' : '',
        '</div>'
      ].filter(Boolean).join('');
    }
    function publicJobStatusHtml(job) {
      const readyRunID = job.status === "completed" ? job.latestRunID : undefined;
      const watchUrl = readyRunID ? "/proxywar-replay/" + encodeURIComponent(readyRunID) : "";
      const runLinks = readyRunID ? [
        '<a href="' + watchUrl + '">Watch rendered gameplay</a>',
        '<a href="/runs/' + encodeURIComponent(readyRunID) + '/match-package.html">Match package</a>',
        '<a href="/runs/' + encodeURIComponent(readyRunID) + '/visual-report.html">Decision report</a>',
        '<a href="/runs/' + encodeURIComponent(readyRunID) + '/spectator.html">Replay timeline</a>',
        '<a href="/runs/' + encodeURIComponent(readyRunID) + '/objective-scorecard.md">Scorecard</a>',
        '<a href="/runs/' + encodeURIComponent(readyRunID) + '/external-agent-feedback.md">External-agent feedback</a>'
      ].join(' · ') : "";
      if (job.status === "completed" && watchUrl && !window.__proxyWarAutoWatchRunID) {
        window.__proxyWarAutoWatchRunID = readyRunID;
        setTimeout(() => {
          window.location.href = watchUrl;
        }, 1200);
      }
      const lines = [
        '<strong>Match job: ' + escapeText(job.status) + '</strong>',
        job.label ? 'Type: ' + escapeText(job.label) : "",
        job.latestRunID ? 'Run: <code>' + escapeText(job.latestRunID) + '</code>' : 'Waiting for verified replay artifact...',
        job.status === "completed" && watchUrl ? '<span class="pill good">Opening rendered match...</span>' : "",
        job.status === "completed" && runLinks ? '<div class="links">' + runLinks + '</div>' : "",
        job.status === "failed" ? '<span class="pill bad">Failed</span> ' + escapeText(job.errorSummary || "No clear error was reported.") : "",
        job.status === "queued" ? '<span class="hint">Queued. Another match is currently running or waiting ahead of this one.</span>' : "",
        job.status === "running" ? '<span class="hint">Codex is planning the match. This can take a few minutes; leave this tab open and it will update automatically.</span>' : ""
      ].filter(Boolean);
      return lines.join("<br>");
    }
    function escapeText(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }
  </script>
</body>
</html>`;
}

export function renderProxyWarAdminHtml(model: ProxyWarAdminModel): string {
  const externalNations = model.hub.savedNations.filter(
    (nation) => nation.provider?.provider === "external-http",
  );
  const latestRenderedRun = featuredRenderedRun(model.hub.runs);
  const readiness = model.server.publicReadiness;
  const jobRows = model.hub.jobs.map((job) => jobRow(job)).join("\n");
  const savedRows = model.hub.savedNations
    .map((nation) => {
      const provider = savedNationProviderSummary(nation);
      return `<tr>
        <td>${escapeHtml(nation.agentName)}</td>
        <td>${escapeHtml(nation.profile)}</td>
        <td>${escapeHtml(provider)}</td>
        <td>${escapeHtml(nation.createdAt)}</td>
      </tr>`;
    })
    .join("\n");
  const rateRows = Object.entries(model.server.rateLimits)
    .map(
      ([scope, limit]) =>
        `<tr><td>${escapeHtml(scope)}</td><td>${limit <= 0 ? "off" : escapeHtml(String(limit))}</td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Admin</title>
  <style>
    :root { color-scheme: light; --ink:#142030; --muted:#5c6f83; --line:#d7e0ea; --paper:#f5f8fb; --panel:#fff; --accent:#1e6d64; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--paper); color:var(--ink); font:14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { padding:30px 32px; color:white; background:linear-gradient(135deg, #102236, #205866 58%, #1e6d64); }
    header h1 { margin:0; font-size:34px; letter-spacing:0; }
    header p { margin:8px 0 0; color:#dce9f0; }
    main { max-width:1180px; margin:0 auto; padding:24px; }
    a { color:var(--accent); font-weight:800; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:18px; }
    .stat, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; box-shadow:0 8px 24px rgba(17, 35, 52, .05); }
    .stat span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .stat strong { display:block; font-size:28px; margin-top:4px; }
    table { width:100%; border-collapse:collapse; background:white; border:1px solid var(--line); border-radius:8px; overflow:hidden; margin-top:10px; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#eef4f5; color:#46576c; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .hint { color:var(--muted); font-size:13px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <header>
    <h1>Proxy War Admin</h1>
    <p>Local beta control-plane status. Secrets and local filesystem paths are intentionally not shown here.</p>
  </header>
  <main>
    <section class="grid">
      <div class="stat"><span>Beta Gate</span><strong>${model.server.betaEnabled ? "On" : "Off"}</strong></div>
      <div class="stat"><span>Saved Nations</span><strong>${model.hub.savedNations.length}</strong></div>
      <div class="stat"><span>External Agents</span><strong>${externalNations.length}</strong></div>
      <div class="stat"><span>Public Readiness</span><strong>${readiness?.status ?? "Unknown"}</strong></div>
      <div class="stat"><span>Queued Jobs</span><strong>${model.server.queuedJobCount}/${model.server.maxQueuedJobs}</strong></div>
      <div class="stat"><span>Running Job</span><strong>${model.server.runningJobID === null ? "None" : "Yes"}</strong></div>
      <div class="stat"><span>Rate Buckets</span><strong>${model.server.rateLimitBucketCount}</strong></div>
    </section>
    <section class="panel">
      <h2>Quick Links</h2>
      <div class="links">
        <a href="/public">Public beta page</a>
        <a href="/">Operator hub</a>
        <a href="/api/status">Status JSON</a>
        <a href="/api/public-readiness">Public readiness JSON</a>
        ${latestRenderedRun?.hasOpenFrontReplay ? `<a href="/proxywar-replay/${encodeURIComponent(latestRenderedRun.runID)}">Latest rendered replay</a>` : ""}
      </div>
      <p class="hint">Renderer: ${escapeHtml(model.server.rendererBaseUrl)}</p>
    </section>
    ${
      readiness === undefined
        ? ""
        : `<section class="panel">
            <h2>Public Readiness</h2>
            <p>${readinessStatusPill(readiness.status)} <span class="hint">${escapeHtml(readiness.mode)} · share <code>${escapeHtml(readiness.shareUrl)}</code></span></p>
            <table><thead><tr><th>Check</th><th>Status</th><th>Message</th></tr></thead><tbody>${readinessRows(readiness)}</tbody></table>
            <p class="hint">Next: ${escapeHtml(readiness.nextActions[0] ?? "No action needed.")}</p>
          </section>`
    }
    <section class="panel">
      <h2>Saved Entrants</h2>
      ${
        savedRows === ""
          ? '<p class="hint">No saved entrants yet.</p>'
          : `<table><thead><tr><th>Nation</th><th>Profile</th><th>Provider</th><th>Created</th></tr></thead><tbody>${savedRows}</tbody></table>`
      }
    </section>
    <section class="panel">
      <h2>Jobs</h2>
      ${
        jobRows === ""
          ? '<p class="hint">No jobs recorded yet.</p>'
          : `<table><thead><tr><th>Job</th><th>Status</th><th>Started</th><th>Completed</th><th>Latest Artifact</th><th>Error</th></tr></thead><tbody>${jobRows}</tbody></table>`
      }
    </section>
    <section class="panel">
      <h2>Rate Limits</h2>
      <table><thead><tr><th>Scope</th><th>Limit per window</th></tr></thead><tbody>${rateRows}</tbody></table>
      <p class="hint">These are local persisted beta limits. Hosted beta should still use edge or database-backed limits.</p>
    </section>
  </main>
</body>
</html>`;
}

export function renderProxyWarTesterDashboardHtml(
  model: ProxyWarTesterDashboardModel,
): string {
  const externalNations = model.hub.savedNations.filter(
    (nation) => nation.provider?.provider === "external-http",
  );
  const latestRenderedRun = featuredRenderedRun(model.hub.runs);
  const latestFeedbackRun =
    model.hub.runs.find((run) => run.hasExternalFeedback) ?? latestRenderedRun;
  const activeJob =
    model.hub.jobs.find(
      (job) => job.status === "running" || job.status === "queued",
    ) ?? null;
  const jobRows = model.hub.jobs
    .slice(0, 8)
    .map(
      (job) => `<tr>
        <td>${escapeHtml(job.label)}</td>
        <td>${statusPill(job.status)}</td>
        <td>${escapeHtml(job.startedAt)}</td>
        <td>${escapeHtml(job.completedAt ?? "pending")}</td>
        <td>${job.artifactID ? `<code>${escapeHtml(job.artifactID)}</code>` : ""}</td>
      </tr>`,
    )
    .join("\n");
  const externalRows = externalNations
    .map(
      (nation) => `<tr>
        <td>${escapeHtml(nation.agentName)}</td>
        <td>${escapeHtml(nation.profile)}</td>
        <td>${escapeHtml(savedNationProviderSummary(nation))}</td>
        <td>${escapeHtml(nation.createdAt)}</td>
      </tr>`,
    )
    .join("\n");
  const runRows = model.hub.runs
    .slice(0, 8)
    .map(
      (run) => `<tr>
        <td><code>${escapeHtml(run.runID)}</code></td>
        <td>${numberCell(run.decisionCount)}</td>
        <td>${numberCell(run.postSpawnNonHoldActionCount)}</td>
        <td>${numberCell(run.acceptedCount)} / ${numberCell(run.rejectedCount)}</td>
        <td class="links">
          ${run.hasOpenFrontReplay ? `<a href="/proxywar-replay/${encodeURIComponent(run.runID)}">replay</a>` : ""}
          ${run.hasMatchPackage ? `<a href="/runs/${encodeURIComponent(run.runID)}/${run.matchPackageLinkFileName}">package</a>` : ""}
          ${run.hasExternalFeedback ? `<a href="/runs/${encodeURIComponent(run.runID)}/external-agent-feedback.md">feedback</a>` : ""}
        </td>
      </tr>`,
    )
    .join("\n");
  const readinessRowsHtml =
    model.server.publicReadiness === undefined
      ? ""
      : readinessRows(model.server.publicReadiness);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy War Tester Dashboard</title>
  <style>
    :root { color-scheme: dark; --paper:#07090d; --panel:#11151e; --line:#252d3c; --ink:#e8edf5; --muted:#93a0b4; --accent:#f4a64a; --good:#7ee0a8; --bad:#ff7a6b; --warn:#f0c869; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(900px 420px at 20% 0%, rgba(244,166,74,.08), transparent 60%), var(--paper); color:var(--ink); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
    header, main { width:min(1180px, calc(100% - 32px)); margin:0 auto; }
    header { padding:26px 0 14px; display:flex; justify-content:space-between; align-items:end; gap:18px; flex-wrap:wrap; }
    h1 { margin:0; font-size:38px; letter-spacing:-.03em; }
    h2 { margin:0 0 10px; font-size:20px; }
    p { margin:0; }
    a { color:#7ad7f0; font-weight:800; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .hint { color:var(--muted); font-size:13px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:12px; margin:12px 0; }
    .stat, .panel { background:rgba(17,21,30,.94); border:1px solid var(--line); border-radius:8px; padding:16px; box-shadow:0 24px 60px -35px #000; }
    .stat span { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.05em; font-weight:850; }
    .stat strong { display:block; margin-top:3px; font-size:26px; }
    main { display:grid; gap:12px; padding-bottom:42px; }
    .links { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .button, button { min-height:38px; display:inline-flex; align-items:center; justify-content:center; padding:9px 12px; border:1px solid rgba(244,166,74,.42); border-radius:6px; background:rgba(244,166,74,.13); color:var(--accent); font:850 13px/1 inherit; cursor:pointer; }
    button:disabled { opacity:.55; cursor:wait; }
    table { width:100%; border-collapse:collapse; overflow:hidden; border-radius:8px; }
    th, td { border-bottom:1px solid var(--line); padding:9px 10px; text-align:left; vertical-align:top; }
    th { color:#bcc6d7; background:#161c28; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
    code { color:#dce6f6; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .pill { display:inline-flex; min-height:22px; align-items:center; padding:2px 8px; border-radius:999px; background:#202838; color:#c9d3e3; font-size:12px; font-weight:850; }
    .pill.good { background:rgba(126,224,168,.14); color:var(--good); }
    .pill.bad { background:rgba(255,122,107,.14); color:var(--bad); }
    .pill.warn, .pill.busy { background:rgba(240,200,105,.14); color:var(--warn); }
    .empty { color:var(--muted); border:1px dashed var(--line); border-radius:8px; padding:14px; }
    #endpoint-health-output { white-space:pre-wrap; margin-top:10px; color:#cfd8e8; }
    @media (max-width:720px) { header { align-items:start; } .links { flex-direction:column; align-items:stretch; } .button, button { width:100%; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Tester Dashboard</h1>
      <p class="hint">Invite-gated operational view for endpoint health, queue status, latest replay, and feedback.</p>
    </div>
    <nav class="links">
      <a class="button" href="/public">Beta page</a>
      ${latestRenderedRun?.hasOpenFrontReplay ? `<a class="button" href="/proxywar-replay/${encodeURIComponent(latestRenderedRun.runID)}">Latest replay</a>` : ""}
      <a class="button" href="/api/public-readiness">Readiness JSON</a>
    </nav>
  </header>
  <main>
    <section class="grid">
      <div class="stat"><span>Queue</span><strong>${activeJob === null ? "Idle" : activeJob.status}</strong></div>
      <div class="stat"><span>Queued Jobs</span><strong>${model.server.queuedJobCount}/${model.server.maxQueuedJobs}</strong></div>
      <div class="stat"><span>Saved Agents</span><strong>${model.hub.savedNations.length}</strong></div>
      <div class="stat"><span>External Endpoints</span><strong>${externalNations.length}</strong></div>
      <div class="stat"><span>Readiness</span><strong>${model.server.publicReadiness?.status ?? "unknown"}</strong></div>
    </section>
    <section class="panel">
      <h2>Latest Replay And Feedback</h2>
      ${
        latestRenderedRun === null
          ? '<div class="empty">No rendered run found yet. Run a match before sharing the beta.</div>'
          : `<p><code>${escapeHtml(latestRenderedRun.runID)}</code></p>
            <div class="links" style="margin-top:10px">
              ${latestRenderedRun.hasOpenFrontReplay ? `<a href="/proxywar-replay/${encodeURIComponent(latestRenderedRun.runID)}">Rendered replay</a>` : ""}
              ${latestRenderedRun.hasMatchPackage ? `<a href="/runs/${encodeURIComponent(latestRenderedRun.runID)}/${latestRenderedRun.matchPackageLinkFileName}">Match package</a>` : ""}
              <a href="/runs/${encodeURIComponent(latestRenderedRun.runID)}/visual-report.html">Decision report</a>
              ${latestFeedbackRun?.hasExternalFeedback ? `<a href="/runs/${encodeURIComponent(latestFeedbackRun.runID)}/external-agent-feedback.md">External-agent feedback</a>` : ""}
            </div>`
      }
    </section>
    <section class="panel">
      <h2>Endpoint Health</h2>
      <p class="hint">Checks saved external agents through the same strict HTTPS/private-network policy used in matches. Tokens are resolved server-side and never shown here.</p>
      <button id="check-endpoints" type="button">Check Saved External Endpoints</button>
      <div id="endpoint-health-output" class="empty">Endpoint health not checked yet.</div>
    </section>
    <section class="panel">
      <h2>Saved External Agents</h2>
      ${
        externalRows === ""
          ? '<div class="empty">No saved external agents yet. Import an Agent Card or save an endpoint from the beta page.</div>'
          : `<table><thead><tr><th>Nation</th><th>Profile</th><th>Endpoint</th><th>Created</th></tr></thead><tbody>${externalRows}</tbody></table>`
      }
    </section>
    <section class="panel">
      <h2>Recent Match Jobs</h2>
      ${
        jobRows === ""
          ? '<div class="empty">No match jobs recorded yet.</div>'
          : `<table><thead><tr><th>Job</th><th>Status</th><th>Started</th><th>Completed</th><th>Artifact</th></tr></thead><tbody>${jobRows}</tbody></table>`
      }
    </section>
    <section class="panel">
      <h2>Recent Runs</h2>
      ${
        runRows === ""
          ? '<div class="empty">No run artifacts yet.</div>'
          : `<table><thead><tr><th>Run</th><th>Decisions</th><th>Non-hold</th><th>Accepted / Rejected</th><th>Links</th></tr></thead><tbody>${runRows}</tbody></table>`
      }
    </section>
    ${
      readinessRowsHtml === ""
        ? ""
        : `<section class="panel">
            <h2>Readiness Checks</h2>
            <table><thead><tr><th>Check</th><th>Status</th><th>Message</th></tr></thead><tbody>${readinessRowsHtml}</tbody></table>
          </section>`
    }
  </main>
  <script>
    const output = document.getElementById("endpoint-health-output");
    const button = document.getElementById("check-endpoints");
    button?.addEventListener("click", async () => {
      button.disabled = true;
      output.textContent = "Checking saved external endpoints...";
      try {
        const response = await fetch("/api/tester-dashboard/endpoint-health", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "endpoint health failed");
        if (!result.results || result.results.length === 0) {
          output.textContent = "No saved external endpoints to check.";
          return;
        }
        output.innerHTML = result.results.map((item) => {
          const status = item.ok ? '<span class="pill good">pass</span>' : '<span class="pill bad">fail</span>';
          const detail = item.ok
            ? "selected " + escapeText(item.selectedLegalActionId || "unknown") + " in " + escapeText(String(item.latencyMs)) + "ms"
            : escapeText([item.failureReason || "unknown failure", item.fixHint ? "Fix: " + item.fixHint : ""].filter(Boolean).join(" "));
          return "<p>" + status + " <strong>" + escapeText(item.agentName) + "</strong> · " + escapeText(item.endpoint) + "<br><span class=\\"hint\\">" + detail + "</span></p>";
        }).join("");
      } catch (error) {
        output.textContent = "Endpoint health failed: " + String(error);
      } finally {
        button.disabled = false;
      }
    });
    function escapeText(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char] || char));
    }
  </script>
</body>
</html>`;
}

async function discoverTournaments(
  tournamentsRootDir: string,
  limit: number,
): Promise<AgentDemoTournamentIndexEntry[]> {
  try {
    await fs.mkdir(tournamentsRootDir, { recursive: true });
    const dirents = await fs.readdir(tournamentsRootDir, {
      withFileTypes: true,
    });
    const directoryCandidates = recentDirectoryCandidates(dirents, limit);
    const entries = await Promise.all(
      directoryCandidates.map(async (dirent) => {
        const directory = path.join(tournamentsRootDir, dirent.name);
        const summaryPath = path.join(directory, "tournament-summary.json");
        const summary = await readJson<TournamentIndexSummary>(summaryPath);
        if (summary === null) return null;
        return {
          ...summary,
          tournamentID: summary.tournamentID ?? dirent.name,
          directory,
          summaryPath,
          reportPath: path.join(directory, "tournament-report.md"),
          leaderboardPath: path.join(directory, "leaderboard.json"),
          leaderboardHtmlPath: path.join(directory, "leaderboard.html"),
        };
      }),
    );
    return entries
      .filter((entry): entry is AgentDemoTournamentIndexEntry => entry !== null)
      .sort((a, b) => timestamp(b.completedAt) - timestamp(a.completedAt))
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

async function discoverEvaluations(
  evaluationsRootDir: string,
  limit: number,
): Promise<AgentDemoEvaluationIndexEntry[]> {
  try {
    await fs.mkdir(evaluationsRootDir, { recursive: true });
    const dirents = await fs.readdir(evaluationsRootDir, {
      withFileTypes: true,
    });
    const directoryCandidates = recentDirectoryCandidates(dirents, limit);
    const entries = await Promise.all(
      directoryCandidates.map(async (dirent) => {
        const directory = path.join(evaluationsRootDir, dirent.name);
        const summaryPath = path.join(directory, "evaluation-summary.json");
        const summary = await readJson<EvaluationIndexSummary>(summaryPath);
        if (summary === null) return null;
        return {
          ...summary,
          evalID: summary.evalID ?? dirent.name,
          directory,
          summaryPath,
          reportPath: path.join(directory, "evaluation-report.md"),
        };
      }),
    );
    return entries
      .filter((entry): entry is AgentDemoEvaluationIndexEntry => entry !== null)
      .sort((a, b) => timestamp(b.completedAt) - timestamp(a.completedAt))
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

function recentDirectoryCandidates<
  T extends { isDirectory(): boolean; name: string },
>(dirents: T[], limit: number): T[] {
  const poolSize = Math.max(limit * 8, 160);
  return dirents
    .filter((dirent) => dirent.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, poolSize);
}

async function discoverManifests(
  manifestDir: string,
): Promise<AgentDemoManifestEntry[]> {
  try {
    const manifests = await loadAgentManifestsFromDirectory(manifestDir);
    const files = (await fs.readdir(manifestDir))
      .filter((file) => file.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
    return manifests.map((manifest, index) => ({
      ...manifest,
      fileName: files[index],
    }));
  } catch {
    return [];
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function renderArenaTiles(): string {
  const pattern = [
    "",
    "",
    "a",
    "a",
    "a",
    "",
    "",
    "b",
    "b",
    "",
    "",
    "",
    "",
    "a",
    "a",
    "a",
    "a",
    "",
    "b",
    "b",
    "b",
    "",
    "c",
    "",
    "",
    "a",
    "a",
    "",
    "",
    "",
    "b",
    "b",
    "",
    "c",
    "c",
    "c",
    "",
    "",
    "",
    "",
    "d",
    "d",
    "",
    "",
    "",
    "c",
    "c",
    "",
    "e",
    "e",
    "",
    "d",
    "d",
    "d",
    "",
    "a",
    "",
    "",
    "",
    "",
    "e",
    "e",
    "e",
    "",
    "d",
    "",
    "a",
    "a",
    "a",
    "",
    "b",
    "",
    "",
    "e",
    "",
    "",
    "",
    "",
    "a",
    "a",
    "",
    "b",
    "b",
    "b",
    "",
    "",
    "",
    "c",
    "c",
    "",
    "",
    "",
    "",
    "b",
    "b",
    "",
  ];
  return pattern
    .map((kind) => `<span class="tile${kind === "" ? "" : ` ${kind}`}"></span>`)
    .join("");
}

function runRow(run: AgentDemoRunIndexEntry): string {
  const runID = encodeURIComponent(run.runID);
  return `<tr>
    <td><code>${escapeHtml(run.runID)}</code><div class="hint">${escapeHtml(run.completedAt ?? "unknown")}</div></td>
    <td><span class="pill">${escapeHtml(run.brainMode ?? "unknown")}</span></td>
    <td>${escapeHtml(run.scenario ?? "unknown")}</td>
    <td>${escapeHtml(run.runnerMode ?? "unknown")}</td>
    <td>${numberCell(run.decisionCount)}</td>
    <td>${numberCell(run.postSpawnNonHoldActionCount)}</td>
    <td><span class="pill good">${numberCell(run.acceptedCount)}</span> <span class="pill bad">${numberCell(run.rejectedCount)}</span></td>
    <td>${numberCell(run.parseFailureCount)} / ${numberCell(run.fallbackCount)}</td>
    <td>${auditPills(run.confirmedEffectCount, run.unknownEffectCount, run.failedEffectCount)}</td>
    <td class="links">
      ${run.hasOpenFrontReplay ? `<a href="/proxywar-replay/${runID}" target="_blank">rendered gameplay</a>` : ""}
      ${run.hasMatchPackage ? `<a href="/runs/${runID}/${run.matchPackageLinkFileName}">match package</a>` : ""}
      <a href="/runs/${runID}/visual-report.html">decision report</a>
      ${run.hasSpectatorReplay ? `<a href="/runs/${runID}/spectator.html">artifact replay</a>` : ""}
      <a href="/runs/${runID}/match-report.md">markdown</a>
      ${run.hasScorecard ? `<a href="/runs/${runID}/objective-scorecard.md">scorecard</a>` : ""}
      <a href="/runs/${runID}/decisions.jsonl">jsonl</a>
      <a href="/runs/${runID}/match-summary.json">summary</a>
    </td>
  </tr>`;
}

function publicRunRow(run: AgentDemoRunIndexEntry): string {
  const runID = encodeURIComponent(run.runID);
  return `<tr>
    <td><code>${escapeHtml(run.runID)}</code><div class="hint">${escapeHtml(run.completedAt ?? "unknown")}</div></td>
    <td>${escapeHtml(run.brainMode ?? "unknown")}</td>
    <td>${numberCell(run.decisionCount)}</td>
    <td>${numberCell(run.postSpawnNonHoldActionCount)}</td>
    <td class="links">
      ${run.hasOpenFrontReplay ? `<a href="/proxywar-replay/${runID}" target="_blank">rendered gameplay</a>` : ""}
      ${run.hasMatchPackage ? `<a href="/runs/${runID}/${run.matchPackageLinkFileName}">match package</a>` : ""}
      <a href="/runs/${runID}/visual-report.html">decision report</a>
      ${run.hasSpectatorReplay ? `<a href="/runs/${runID}/spectator.html">replay</a>` : ""}
      ${run.hasScorecard ? `<a href="/runs/${runID}/objective-scorecard.md">scorecard</a>` : ""}
    </td>
  </tr>`;
}

function tournamentRow(tournament: AgentDemoTournamentIndexEntry): string {
  const tournamentID = encodeURIComponent(tournament.tournamentID);
  return `<tr>
    <td><code>${escapeHtml(tournament.tournamentID)}</code><div class="hint">${escapeHtml(tournament.completedAt ?? "unknown")}</div></td>
    <td><span class="pill">${escapeHtml(tournament.brain ?? "unknown")}</span></td>
    <td>${escapeHtml(tournament.scenario ?? "unknown")}</td>
    <td>${numberCell(tournament.runCount)}</td>
    <td>${numberCell(tournament.postSpawnNonHoldActionCount)}</td>
    <td><span class="pill good">${numberCell(tournament.acceptedCount)}</span> <span class="pill bad">${numberCell(tournament.rejectedCount)}</span></td>
    <td>${numberCell(tournament.parserFailureCount)} / ${numberCell(tournament.fallbackCount)}</td>
    <td>${auditPills(tournament.auditStats?.confirmed, tournament.auditStats?.unknown, tournament.auditStats?.failed)}</td>
    <td class="links">
      <a href="/tournaments/${tournamentID}/leaderboard.html">leaderboard</a>
      <a href="/tournaments/${tournamentID}/tournament-report.md">report</a>
      <a href="/tournaments/${tournamentID}/tournament-summary.json">summary</a>
      <a href="/tournaments/${tournamentID}/leaderboard.json">json</a>
    </td>
  </tr>`;
}

function evaluationRow(evaluation: AgentDemoEvaluationIndexEntry): string {
  const evalID = encodeURIComponent(evaluation.evalID);
  return `<tr>
    <td><code>${escapeHtml(evaluation.evalID)}</code><div class="hint">${escapeHtml(evaluation.completedAt ?? "unknown")}</div></td>
    <td><span class="pill">${escapeHtml(evaluation.brain ?? "unknown")}</span></td>
    <td>${escapeHtml(evaluation.scenario ?? "unknown")}</td>
    <td>${numberCell(evaluation.runCount)}</td>
    <td>${numberCell(evaluation.decisionCount)}</td>
    <td>non-hold ${percent(evaluation.nonHoldRate)} · accepted ${percent(evaluation.acceptedRate)} · fallback ${percent(evaluation.fallbackRate)} · parser ${percent(evaluation.parserFailureRate)}</td>
    <td class="links">
      <a href="/evaluations/${evalID}/evaluation-report.md">report</a>
      <a href="/evaluations/${evalID}/evaluation-summary.json">summary</a>
    </td>
  </tr>`;
}

function jobRow(job: AgentDemoJobRecord): string {
  return `<tr>
    <td><code>${escapeHtml(job.jobID)}</code><div class="hint">${escapeHtml(job.label)}</div></td>
    <td>${statusPill(job.status)}</td>
    <td>${escapeHtml(job.startedAt)}</td>
    <td>${escapeHtml(job.completedAt ?? "running")}</td>
    <td class="links">${jobArtifactLinks(job)}</td>
    <td>${escapeHtml(job.errorSummary ?? "")}</td>
  </tr>`;
}

function manifestCard(manifest: AgentDemoManifestEntry): string {
  const skills = Object.entries(manifest.skillPreferences ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([skill]) => skill.replace(/_/g, " "))
    .join(", ");
  return `<div class="manifest-card">
    <strong>${escapeHtml(manifest.agentName)}</strong>
    <span class="pill">${escapeHtml(manifest.profile)}</span>
    <p>${escapeHtml(manifest.personality ?? "No personality note.")}</p>
    ${skills ? `<p>Top skills: ${escapeHtml(skills)}</p>` : ""}
    ${manifest.fileName ? `<p><code>${escapeHtml(manifest.fileName)}</code></p>` : ""}
  </div>`;
}

function savedNationCard(nation: ProxyWarNationEntry): string {
  const skills = Object.entries(nation.skillPreferences ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([skill]) => skill.replace(/_/g, " "))
    .join(", ");
  const providerLabel = savedNationProviderSummary(nation);
  const modeLabel =
    nation.provider?.provider === "external-http"
      ? "External Agent Brain"
      : "Reference Nation";
  const modeHint =
    nation.provider?.provider === "external-http"
      ? "A user-owned endpoint will choose LegalAction.id values during the match."
      : "Proxy War will run this entrant with the local planner/executor.";
  return `<div class="manifest-card">
    <strong>${escapeHtml(nation.agentName)}</strong>
    <span class="pill good">${escapeHtml(nation.profile)}</span>
    <span class="pill">${escapeHtml(modeLabel)}</span>
    <span class="pill">${escapeHtml(providerLabel)}</span>
    <p>${escapeHtml(nation.personality ?? "No doctrine note.")}</p>
    <p>${escapeHtml(modeHint)}</p>
    ${skills ? `<p>Top skills: ${escapeHtml(skills)}</p>` : ""}
    <p><code>${escapeHtml(nation.fileName)}</code></p>
  </div>`;
}

function sleekSavedNationCard(nation: ProxyWarNationEntry): string {
  const providerLabel = savedNationProviderSummary(nation);
  const modeLabel =
    nation.provider?.provider === "external-http" ? "External" : "Reference";
  const isExternal = nation.provider?.provider === "external-http";
  const skills = Object.entries(nation.skillPreferences ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 2)
    .map(([skill]) => skill.replace(/_/g, " "))
    .join(", ");
  return `<article class="agent-card">
    <header>
      <div>
        <strong>${escapeHtml(nation.agentName)}</strong>
        <div class="hint">${escapeHtml(nation.createdAt)}</div>
      </div>
      <button class="danger" type="button" data-delete-nation-id="${escapeAttribute(nation.nationID)}" data-delete-nation-name="${escapeAttribute(nation.agentName)}">Delete</button>
    </header>
    <div class="meta">
      <span class="pill">${escapeHtml(nation.profile)}</span>
      <span class="pill">${escapeHtml(modeLabel)}</span>
      <span class="pill warn">${escapeHtml(providerLabel)}</span>
    </div>
    <p class="hint">${escapeHtml(nation.personality ?? "No doctrine note.")}</p>
    ${
      nation.policyChangelog
        ? `<p class="policy-change-note"><strong>Policy changelog:</strong> ${escapeHtml(nation.policyChangelog)}</p>`
        : ""
    }
    ${
      isExternal
        ? `<p class="recovery-note"><strong>Before running:</strong> if this endpoint moved, expired, or fails health, delete it and import a fresh Agent Card.</p>`
        : ""
    }
    ${skills ? `<p class="hint">Top skills: ${escapeHtml(skills)}</p>` : ""}
  </article>`;
}

function savedNationProviderSummary(nation: ProxyWarNationEntry): string {
  if (nation.provider?.provider === "external-http") {
    return externalProviderSummary(nation.provider);
  }
  if (nation.brainType === "planner") {
    return "local planner";
  }
  return nation.brainType;
}

function publicExternalFeedbackPanel(
  run: AgentDemoRunIndexEntry | null,
  previousRun: AgentDemoRunIndexEntry | null,
  feedbackRuns: AgentDemoRunIndexEntry[],
  savedNations: ProxyWarNationEntry[],
): string {
  const runID = run?.runID === undefined ? "" : encodeURIComponent(run.runID);
  const preview = run?.externalFeedbackPreview;
  const previousPreview = previousRun?.externalFeedbackPreview;
  const links =
    run === null
      ? ""
      : `<div class="links">
          ${run.hasOpenFrontReplay ? `<a href="/proxywar-replay/${runID}" target="_blank">Watch replay</a>` : ""}
          ${run.hasExternalFeedback ? `<a href="/runs/${runID}/external-agent-feedback.md" target="_blank" data-checklist-feedback-link>Open full feedback</a>` : ""}
          <a href="/runs/${runID}/visual-report.html" target="_blank">Decision report</a>
        </div>`;
  const body =
    run === null
      ? `<div class="status-box">No completed match yet. Run the locked beta match to generate the first replay and feedback surfaces.</div>`
      : preview === undefined
        ? `<div class="status-box">${
            run.hasExternalFeedback
              ? "Feedback exists for this run, but no compact preview was available. Open the full feedback artifact."
              : "This run has no tester external-agent feedback artifact yet. External-agent feedback appears after a run that includes a saved tester agent."
          }</div>`
        : publicExternalFeedbackPreviewHtml(preview, previousPreview);
  return `<details id="agent-feedback" class="card feedback-card supporting-panel">
    <summary>
      <div>
        <h2>Latest Agent Feedback</h2>
        <p class="hint">${
          run === null
            ? "Run a match to generate coaching."
            : `Latest run: <code>${escapeHtml(run.runID)}</code>`
        }</p>
      </div>
    </summary>
    <div class="supporting-panel-body">
      <div class="inline-actions">
        <button id="rerun-feedback-match" class="button" type="button">Rerun Saved Roster</button>
      </div>
    ${body}
    ${publicAgentFeedbackHistoryHtml(feedbackRuns, savedNations)}
    ${links}
    <div id="agent-feedback-status" class="status-box">After updating your agent policy, rerun the saved roster from here to compare behavior.</div>
    </div>
  </details>`;
}

function publicExternalFeedbackPreviewHtml(
  preview: NonNullable<AgentDemoRunIndexEntry["externalFeedbackPreview"]>,
  previousPreview?: AgentDemoRunIndexEntry["externalFeedbackPreview"],
): string {
  const fixes =
    preview.priorityFixes.length > 0
      ? preview.priorityFixes
      : preview.topSuggestions;
  const example = preview.exampleTurns[0];
  const prompt = preview.practicePrompts[0];
  const statusClass = preview.readyForDeveloperReview
    ? "pill"
    : preview.parserFailureCount > 0 || preview.fallbackCount > 0
      ? "pill bad"
      : "pill warn";
  return `<div class="feedback-layout">
    <div class="feedback-summary">
      <div>
        <span class="${statusClass}">${escapeHtml(preview.status)}</span>
        <p style="margin-top:8px">${escapeHtml(preview.summary)}</p>
      </div>
      <div class="feedback-metrics">
        <div class="feedback-metric"><span>External agents</span><strong>${numberCell(preview.externalAgentCount)}</strong></div>
        <div class="feedback-metric"><span>Accepted</span><strong>${percent(preview.acceptedRate)}</strong></div>
        <div class="feedback-metric"><span>Non-hold</span><strong>${percent(preview.nonHoldRate)}</strong></div>
        <div class="feedback-metric"><span>Fallbacks</span><strong>${numberCell(preview.fallbackCount)}</strong></div>
        <div class="feedback-metric"><span>Parser failures</span><strong>${numberCell(preview.parserFailureCount)}</strong></div>
      </div>
      <div class="feedback-block">
        <h3>Fix Next</h3>
        ${
          fixes.length === 0
            ? `<p class="hint">No urgent fix detected. Run a longer match and inspect whether the policy stays active after expansion.</p>`
            : `<ol class="feedback-list">${fixes
                .map((fix) => `<li>${escapeHtml(fix)}</li>`)
                .join("")}</ol>`
        }
      </div>
      ${publicExternalFeedbackComparisonHtml(preview, previousPreview)}
    </div>
    <div>
      <div class="feedback-block">
        <h3>Example Turn</h3>
        ${
          example === undefined
            ? `<p class="hint">No weak example turn was detected in this run.</p>`
            : `<div class="example-turn">
                <div><strong>Turn ${numberCell(example.sequence)} · ${escapeHtml(example.username)}</strong></div>
                <div>${escapeHtml(example.issue)}</div>
                <div>Chose <code>${escapeHtml(example.chosenActionID)}</code></div>
                ${
                  example.recommendedActionKinds.length > 0
                    ? `<div>Consider: ${example.recommendedActionKinds
                        .map((kind) => `<code>${escapeHtml(kind)}</code>`)
                        .join(" ")}</div>`
                    : ""
                }
                <div>${escapeHtml(example.policyHint)}</div>
              </div>`
        }
      </div>
      <div class="feedback-block">
        <h3>Policy Pass Prompt</h3>
        ${
          prompt === undefined
            ? `<p class="hint">No generated prompt yet. Use the Fix Next list as the next policy pass.</p>`
            : `<div class="practice-prompt">${escapeHtml(prompt)}</div>`
        }
      </div>
    </div>
  </div>`;
}

function publicExternalFeedbackComparisonHtml(
  preview: NonNullable<AgentDemoRunIndexEntry["externalFeedbackPreview"]>,
  previousPreview?: AgentDemoRunIndexEntry["externalFeedbackPreview"],
): string {
  if (previousPreview === undefined) {
    return `<div class="feedback-block">
      <h3>Before vs After</h3>
      <p class="hint">Run one more explicit external-agent match after changing the agent policy to compare the new feedback against this run.</p>
    </div>`;
  }
  const currentFix =
    preview.priorityFixes[0] ??
    preview.topSuggestions[0] ??
    "No urgent fix detected.";
  const previousFix =
    previousPreview.priorityFixes[0] ??
    previousPreview.topSuggestions[0] ??
    "No urgent fix detected.";
  const fixMessage =
    currentFix === previousFix
      ? `Same main fix remains: ${currentFix}`
      : `Main fix changed from "${previousFix}" to "${currentFix}".`;
  return `<div class="feedback-block">
    <h3>Before vs After</h3>
    <p class="hint">Compared with previous feedback run <code>${escapeHtml(previousPreview.runID)}</code>.</p>
    <div class="comparison-grid">
      ${comparisonCell("Accepted", preview.acceptedRate, previousPreview.acceptedRate, "percent", true)}
      ${comparisonCell("Non-hold", preview.nonHoldRate, previousPreview.nonHoldRate, "percent", true)}
      ${comparisonCell("Fallbacks", preview.fallbackCount, previousPreview.fallbackCount, "count", false)}
      ${comparisonCell("Parser failures", preview.parserFailureCount, previousPreview.parserFailureCount, "count", false)}
    </div>
    <p class="hint" style="margin-top:10px">${escapeHtml(fixMessage)}</p>
  </div>`;
}

function comparisonCell(
  label: string,
  current: number,
  previous: number,
  format: "percent" | "count",
  higherIsBetter: boolean,
): string {
  const delta = current - previous;
  const className =
    Math.abs(delta) < 0.000001
      ? "flat"
      : higherIsBetter === delta > 0
        ? "good"
        : "bad";
  const deltaText =
    format === "percent" ? percentagePointDelta(delta) : signedNumber(delta);
  const currentText =
    format === "percent" ? percent(current) : numberCell(current);
  const previousText =
    format === "percent" ? percent(previous) : numberCell(previous);
  return `<div class="comparison-cell">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(currentText)}</strong>
    <div class="hint">Before ${escapeHtml(previousText)}</div>
    <div class="delta ${className}">${escapeHtml(deltaText)}</div>
  </div>`;
}

function percentagePointDelta(delta: number): string {
  if (Math.abs(delta) < 0.000001) {
    return "0pp";
  }
  const points = Math.round(delta * 100);
  return `${points > 0 ? "+" : ""}${points}pp`;
}

function signedNumber(value: number): string {
  if (value === 0) {
    return "0";
  }
  return `${value > 0 ? "+" : ""}${numberCell(value)}`;
}

interface PublicAgentFeedbackHistoryEntry {
  runID: string;
  completedAt?: string;
  agent: NonNullable<
    AgentDemoRunIndexEntry["externalFeedbackPreview"]
  >["agents"][number];
}

interface PublicAgentFeedbackHistoryGroup {
  username: string;
  profile: string;
  policyChangelog?: string;
  entries: PublicAgentFeedbackHistoryEntry[];
}

function publicAgentFeedbackHistoryHtml(
  runs: AgentDemoRunIndexEntry[],
  savedNations: ProxyWarNationEntry[],
): string {
  const groups = publicAgentFeedbackHistoryGroups(runs, savedNations, 5).slice(
    0,
    4,
  );
  if (groups.length === 0) {
    return `<div class="feedback-block">
      <h3>Per-Agent History</h3>
      <p class="hint">No per-agent feedback history exists yet. Run explicit external-agent matches to build trends.</p>
    </div>`;
  }
  return `<div class="feedback-block">
    <h3>Per-Agent History</h3>
    <p class="hint">Recent feedback by external agent. Use this to confirm that a policy change helped the specific entrant, not just the aggregate run.</p>
    <div class="agent-history-list">
      ${groups.map(publicAgentFeedbackHistoryGroupHtml).join("")}
    </div>
  </div>`;
}

function publicAgentFeedbackHistoryGroups(
  runs: AgentDemoRunIndexEntry[],
  savedNations: ProxyWarNationEntry[],
  maxEntriesPerAgent: number,
): PublicAgentFeedbackHistoryGroup[] {
  const groups = new Map<string, PublicAgentFeedbackHistoryGroup>();
  const policyChangelogByAgent = new Map(
    savedNations
      .filter((nation) => nation.policyChangelog !== undefined)
      .map((nation) => [
        normalizeAgentHistoryKey(nation.agentName),
        nation.policyChangelog ?? "",
      ]),
  );
  for (const run of runs) {
    const preview = run.externalFeedbackPreview;
    if (preview === undefined) {
      continue;
    }
    for (const agent of preview.agents) {
      const key = normalizeAgentHistoryKey(agent.username) || agent.agentID;
      const policyChangelog = policyChangelogByAgent.get(key);
      const group = groups.get(key) ?? {
        username: agent.username,
        profile: agent.profile,
        ...(policyChangelog !== undefined ? { policyChangelog } : {}),
        entries: [],
      };
      if (group.entries.length < maxEntriesPerAgent) {
        group.entries.push({
          runID: run.runID,
          completedAt: run.completedAt,
          agent,
        });
      }
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.entries.length - a.entries.length,
  );
}

function publicAgentFeedbackHistoryGroupHtml(
  group: PublicAgentFeedbackHistoryGroup,
): string {
  const latest = group.entries[0]?.agent;
  const previous = group.entries[1]?.agent;
  if (latest === undefined) {
    return "";
  }
  const trendText =
    previous === undefined
      ? "Need one more run for a trend."
      : publicAgentTrendSummary(latest, previous);
  return `<div class="agent-history-item">
    <div class="agent-history-head">
      <div>
        <h3>${escapeHtml(group.username)}</h3>
        <p class="hint">${escapeHtml(group.profile)} · ${group.entries.length} feedback run(s)</p>
      </div>
      <span class="${latest.status === "ready" ? "pill" : "pill warn"}">${escapeHtml(latest.status)}</span>
    </div>
    <div class="agent-history-metrics">
      ${agentHistoryMetric("Accepted", percent(latest.acceptedRate), agentDelta(latest.acceptedRate, previous?.acceptedRate, "percent", true))}
      ${agentHistoryMetric("Non-hold", percent(latest.nonHoldRate), agentDelta(latest.nonHoldRate, previous?.nonHoldRate, "percent", true))}
      ${agentHistoryMetric("Fallbacks", numberCell(latest.fallbackCount), agentDelta(latest.fallbackCount, previous?.fallbackCount, "count", false))}
      ${agentHistoryMetric("Parser", numberCell(latest.parserFailureCount), agentDelta(latest.parserFailureCount, previous?.parserFailureCount, "count", false))}
    </div>
    <p class="hint">${escapeHtml(trendText)}</p>
    ${
      group.policyChangelog
        ? `<div class="policy-change-note"><strong>Declared policy change:</strong> ${escapeHtml(group.policyChangelog)}</div>`
        : `<p class="hint">No policy changelog note is saved for this agent yet.</p>`
    }
    <div class="agent-history-table-wrap">
      <table class="agent-history-table">
        <thead><tr><th>Run</th><th>Accepted</th><th>Non-hold</th><th>Fallbacks</th><th>Parser</th><th>Main fix</th></tr></thead>
        <tbody>
          ${group.entries.map(publicAgentHistoryRow).join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function normalizeAgentHistoryKey(value: string): string {
  return value.trim().toLowerCase();
}

function publicAgentHistoryRow(entry: PublicAgentFeedbackHistoryEntry): string {
  const runID = encodeURIComponent(entry.runID);
  return `<tr>
    <td><a href="/runs/${runID}/external-agent-feedback.md" target="_blank" data-checklist-feedback-link>${escapeHtml(shortRunID(entry.runID))}</a><div class="muted-row">${escapeHtml(entry.completedAt ?? "unknown")}</div></td>
    <td>${percent(entry.agent.acceptedRate)}</td>
    <td>${percent(entry.agent.nonHoldRate)}</td>
    <td>${numberCell(entry.agent.fallbackCount)}</td>
    <td>${numberCell(entry.agent.parserFailureCount)}</td>
    <td>${escapeHtml(entry.agent.topSuggestion)}</td>
  </tr>`;
}

function agentHistoryMetric(
  label: string,
  value: string,
  deltaHtml: string,
): string {
  return `<div class="agent-history-metric">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    ${deltaHtml}
  </div>`;
}

function agentDelta(
  current: number,
  previous: number | undefined,
  format: "percent" | "count",
  higherIsBetter: boolean,
): string {
  if (previous === undefined) {
    return `<div class="delta flat">new</div>`;
  }
  const delta = current - previous;
  const className =
    Math.abs(delta) < 0.000001
      ? "flat"
      : higherIsBetter === delta > 0
        ? "good"
        : "bad";
  const text =
    format === "percent" ? percentagePointDelta(delta) : signedNumber(delta);
  return `<div class="delta ${className}">${escapeHtml(text)}</div>`;
}

function publicAgentTrendSummary(
  latest: PublicAgentFeedbackHistoryEntry["agent"],
  previous: PublicAgentFeedbackHistoryEntry["agent"],
): string {
  const acceptedDelta = latest.acceptedRate - previous.acceptedRate;
  const nonHoldDelta = latest.nonHoldRate - previous.nonHoldRate;
  const fallbackDelta = latest.fallbackCount - previous.fallbackCount;
  const parserDelta = latest.parserFailureCount - previous.parserFailureCount;
  const positives = [
    acceptedDelta > 0.000001 ? "accepted decisions improved" : "",
    nonHoldDelta > 0.000001 ? "activity improved" : "",
    fallbackDelta < 0 ? "fallbacks decreased" : "",
    parserDelta < 0 ? "parser failures decreased" : "",
  ].filter(Boolean);
  if (positives.length > 0) {
    return positives.join(", ") + ".";
  }
  if (
    Math.abs(acceptedDelta) < 0.000001 &&
    Math.abs(nonHoldDelta) < 0.000001 &&
    fallbackDelta === 0 &&
    parserDelta === 0
  ) {
    return "No metric movement since the previous run.";
  }
  return "Trend worsened or moved sideways; inspect the main fix before another rerun.";
}

function shortRunID(runID: string): string {
  return runID.length <= 30 ? runID : `${runID.slice(0, 27)}...`;
}

function publicTesterEvidencePacketText(
  state: PublicTesterEvidenceState,
): string {
  return [
    "Proxy War tester evidence",
    `Agent Card URL: ${state.agentCardUrl ?? "none pasted yet"}`,
    `Agent: ${state.agentName ?? "none saved yet"}`,
    `Decision endpoint: ${state.agentEndpoint ?? "none saved yet"}`,
    `Endpoint health: ${state.endpointHealth}`,
    `Job status: ${state.jobStatus}`,
    `Run ID: ${state.runID ?? "none yet"}`,
    `Replay: ${state.replayPath ?? "none yet"}`,
    `Feedback: ${state.feedbackPath ?? "none yet"}`,
    `Failure summary: ${state.failureSummary ?? "none"}`,
  ].join("\n");
}

function sleekPublicRunRow(run: AgentDemoRunIndexEntry): string {
  const runID = encodeURIComponent(run.runID);
  return `<tr>
    <td><code>${escapeHtml(run.runID)}</code><div class="muted-row">${escapeHtml(run.completedAt ?? "unknown")}</div></td>
    <td>${numberCell(run.decisionCount)} decisions<div class="muted-row">${numberCell(run.postSpawnNonHoldActionCount)} non-hold · ${numberCell(run.acceptedCount)} accepted · ${numberCell(run.rejectedCount)} rejected</div></td>
    <td><div class="links">
      ${run.hasOpenFrontReplay ? `<a href="/proxywar-replay/${runID}" target="_blank">rendered replay</a>` : ""}
      ${run.hasMatchPackage ? `<a href="/runs/${runID}/${run.matchPackageLinkFileName}">match package</a>` : ""}
      <a href="/runs/${runID}/visual-report.html">decision report</a>
      ${run.hasSpectatorReplay ? `<a href="/runs/${runID}/spectator.html">timeline</a>` : ""}
      ${run.hasExternalFeedback ? `<a href="/runs/${runID}/external-agent-feedback.md" data-checklist-feedback-link>agent feedback</a>` : ""}
    </div></td>
  </tr>`;
}

function externalProviderSummary(
  provider: Extract<AgentManifest["provider"], { provider: "external-http" }>,
): string {
  if (provider.tokenSecret !== undefined) {
    return "external endpoint (local secret)";
  }
  if (provider.tokenEnv !== undefined) {
    return "external endpoint (env token)";
  }
  if (provider.token !== undefined) {
    return "external endpoint (inline token)";
  }
  return "external endpoint";
}

function jobArtifactLinks(job: AgentDemoJobRecord): string {
  if (job.status !== "completed") {
    return job.artifactID === undefined
      ? '<span class="hint">artifact pending</span>'
      : `<span class="hint">expected <code>${escapeHtml(job.artifactID)}</code></span>`;
  }
  if (job.latestRunID !== undefined) {
    const runID = encodeURIComponent(job.latestRunID);
    return `<a href="/proxywar-replay/${runID}" target="_blank">rendered gameplay</a><a href="/runs/${runID}/match-package.html">match package</a><a href="/runs/${runID}/visual-report.html">decision report</a><a href="/runs/${runID}/spectator.html">timeline</a>`;
  }
  if (job.latestTournamentID !== undefined) {
    const tournamentID = encodeURIComponent(job.latestTournamentID);
    return `<a href="/tournaments/${tournamentID}/leaderboard.html">leaderboard</a><a href="/tournaments/${tournamentID}/tournament-report.md">report</a>`;
  }
  if (job.latestEvaluationID !== undefined) {
    const evalID = encodeURIComponent(job.latestEvaluationID);
    return `<a href="/evaluations/${evalID}/evaluation-report.md">report</a><a href="/evaluations/${evalID}/evaluation-summary.json">summary</a>`;
  }
  return '<span class="hint">none yet</span>';
}

function statusPill(status: AgentDemoJobRecord["status"]): string {
  const className =
    status === "completed" ? "good" : status === "failed" ? "bad" : "warn";
  return `<span class="pill ${className}">${escapeHtml(status)}</span>`;
}

function readinessStatusPill(
  status: ProxyWarPublicReadinessReport["status"],
): string {
  const className =
    status === "ready" ? "good" : status === "blocked" ? "bad" : "warn";
  return `<span class="pill ${className}">${escapeHtml(status)}</span>`;
}

function readinessCheckPill(
  status: ProxyWarPublicReadinessReport["checks"][number]["status"],
): string {
  const className =
    status === "pass" ? "good" : status === "fail" ? "bad" : "warn";
  return `<span class="pill ${className}">${escapeHtml(status)}</span>`;
}

function readinessRows(report: ProxyWarPublicReadinessReport): string {
  return report.checks
    .map(
      (check) => `<tr>
        <td>${escapeHtml(check.label)}</td>
        <td>${readinessCheckPill(check.status)}</td>
        <td>${escapeHtml(check.message)}</td>
      </tr>`,
    )
    .join("\n");
}

function auditPills(
  confirmed: number | undefined,
  unknown: number | undefined,
  failed: number | undefined,
): string {
  return `<span class="pill good">${numberCell(confirmed)}</span> <span class="pill warn">${numberCell(unknown)}</span> <span class="pill bad">${numberCell(failed)}</span>`;
}

function featuredRenderedRun(
  runs: AgentDemoRunIndexEntry[],
): AgentDemoRunIndexEntry | null {
  return (
    runs.find(
      (run) =>
        run.hasOpenFrontReplay &&
        (run.decisionCount ?? 0) >= 8 &&
        (run.postSpawnNonHoldActionCount ?? 0) >= 2,
    ) ??
    runs.find((run) => run.hasOpenFrontReplay) ??
    runs[0] ??
    null
  );
}

function featuredShowcaseTournament(
  tournaments: AgentDemoTournamentIndexEntry[],
): AgentDemoTournamentIndexEntry | null {
  return (
    tournaments.find(
      (tournament) =>
        tournament.showcase?.bestRunID !== undefined &&
        tournament.showcase.bestRunID !== null &&
        tournament.showcase?.status === "showcase-ready",
    ) ??
    tournaments.find(
      (tournament) =>
        tournament.showcase?.bestRunID !== undefined &&
        tournament.showcase.bestRunID !== null,
    ) ??
    tournaments[0] ??
    null
  );
}

function publicTournamentBestReplayLink(
  tournament: AgentDemoTournamentIndexEntry,
): string | null {
  const runID = tournament.showcase?.bestRunID;
  if (typeof runID === "string" && runID.trim() !== "") {
    return `/proxywar-replay/${encodeURIComponent(runID)}`;
  }
  const replayPath = tournament.showcase?.bestRunReplayPath;
  if (
    typeof replayPath === "string" &&
    (replayPath.startsWith("/proxywar-replay/") ||
      replayPath.startsWith("/ai-league-replay/"))
  ) {
    return replayPath;
  }
  return null;
}

function publicTournamentAgentCard(
  agent: TournamentIndexShowcaseAgent,
): string {
  const tags = Array.isArray(agent.styleTags)
    ? agent.styleTags.filter((tag) => typeof tag === "string").slice(0, 4)
    : [];
  return `<article class="agent-card">
    <strong>${escapeHtml(agent.agentName ?? "Agent")}</strong>
    <div class="meta">
      <span class="pill">${escapeHtml(agent.profile ?? "profile")}</span>
      ${tags.map((tag) => `<span class="pill warn">${escapeHtml(tag)}</span>`).join("")}
    </div>
    <p class="hint">${escapeHtml(agent.personality ?? "No doctrine note.")}</p>
  </article>`;
}

function publicTournamentLeaderboardRow(
  agent: TournamentIndexLeaderboardEntry,
  index: number,
): string {
  return `<tr>
    <td>${index + 1}</td>
    <td>${escapeHtml(agent.agentName ?? "Agent")}<div class="muted-row">${escapeHtml(agent.profile ?? "profile")}</div></td>
    <td>${numberCell(agent.totalScore)}</td>
  </tr>`;
}

function numberCell(value: number | undefined): string {
  return String(value ?? 0);
}

function percent(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}

function selectedAttribute(value: string, option: string): string {
  return value === option ? " selected" : "";
}

function sum(
  runs: AgentDemoRunIndexEntry[],
  key: keyof Pick<
    AgentDemoRunIndexEntry,
    "acceptedCount" | "postSpawnNonHoldActionCount"
  >,
): number {
  return runs.reduce((total, run) => total + (run[key] ?? 0), 0);
}

function timestamp(value: string | undefined): number {
  return value === undefined ? 0 : new Date(value).getTime();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
