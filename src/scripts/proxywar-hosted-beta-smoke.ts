import {
  proxyWarTesterSavedRosterJobDefaults,
} from "../server/agents/AgentDemoServerJobs";

type SmokeStatus = "pass" | "fail";

interface SmokeCheck {
  id: string;
  label: string;
  status: SmokeStatus;
  message: string;
}

interface SmokeOptions {
  publicUrl: string;
  inviteCode: string;
  timeoutMs: number;
  runMatch: boolean;
  matchTimeoutMs: number;
  json: boolean;
}

interface CookieJar {
  header: string;
  secure: boolean;
}

interface TesterDashboardApi {
  ok?: boolean;
  latestRun?: {
    runID?: string;
    replayUrl?: string | null;
  } | null;
}

interface JobResponse {
  jobID?: string;
  status?: "queued" | "running" | "completed" | "failed";
  replayUrl?: string;
  latestRunID?: string;
  errorSummary?: string;
}

interface SmokeReport {
  status: "ready" | "blocked";
  generatedAt: string;
  shareUrl: string;
  checks: SmokeCheck[];
  latestReplayUrl: string | null;
  createdReplayUrl: string | null;
}

const options = parseArgsOrExit(process.argv.slice(2));
const checks: SmokeCheck[] = [];
let cookie: CookieJar | null = null;
let latestReplayUrl: string | null = null;
let createdReplayUrl: string | null = null;

await runCheck("hosted_url", "Hosted URL", async () => {
  if (!options.publicUrl.startsWith("https://")) {
    throw new Error("PROXYWAR_PUBLIC_URL must be an HTTPS beta URL.");
  }
  if (
    options.publicUrl.includes("example.") ||
    options.publicUrl.includes("your-beta-url")
  ) {
    throw new Error("PROXYWAR_PUBLIC_URL still looks like a placeholder.");
  }
  return `Using ${options.publicUrl}`;
});

await runCheck("invite_gate", "Invite gate", async () => {
  const response = await request("/public", { redirect: "manual" });
  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`Expected /public to redirect to the invite gate, got ${response.status}.`);
  }
  const location = response.headers.get("location") ?? "";
  if (!location.startsWith("/beta")) {
    throw new Error(`Expected /public to redirect to /beta, got ${location || "<none>"}.`);
  }
  return "/public is invite-gated.";
});

await runCheck("agent_start", "Agent start page", async () => {
  const response = await request("/agent-start");
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected /agent-start 200, got ${response.status}.`);
  }
  if (!text.includes("ProxyWar Agent Start")) {
    throw new Error("/agent-start did not render the agent onboarding page.");
  }
  if (!text.includes("selectedLegalActionId")) {
    throw new Error("/agent-start did not show the strict decision contract.");
  }
  return "/agent-start loads with the external-agent contract.";
});

await runCheck("agent_start_json", "Agent start JSON", async () => {
  const response = await request("/agent-start.json");
  const json = await parseJson<Record<string, unknown>>(response);
  if (response.status !== 200) {
    throw new Error(`Expected /agent-start.json 200, got ${response.status}.`);
  }
  if (json === null || json.startPage !== "/agent-start") {
    throw new Error("/agent-start.json did not include the expected startPage.");
  }
  return "/agent-start.json is machine-readable.";
});

await runCheck("login", "Invite login", async () => {
  const body = new URLSearchParams({
    inviteCode: options.inviteCode,
    returnTo: "/public",
  });
  const response = await request("/api/beta/login", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    redirect: "manual",
  });
  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`Expected invite login redirect, got ${response.status}.`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null || setCookie.trim() === "") {
    throw new Error("Invite login did not set a beta session cookie.");
  }
  const parsedCookie = cookieFromSetCookie(setCookie);
  if (parsedCookie === null) {
    throw new Error("Invite login returned an unreadable beta session cookie.");
  }
  if (!parsedCookie.secure) {
    throw new Error("HTTPS beta login did not mark the invite cookie Secure.");
  }
  cookie = parsedCookie;
  return "Invite code creates a Secure beta session.";
});

await runCheck("public_page", "Public page", async () => {
  const response = await request("/public", { cookie: requireCookie() });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected authenticated /public 200, got ${response.status}.`);
  }
  for (const required of [
    "ProxyWar",
    "Agent Card",
    "Run First Match",
    "rendered replay",
    "agent-start",
    "12-round saved-roster match",
  ]) {
    if (!text.includes(required)) {
      throw new Error(`/public is missing expected tester text: ${required}.`);
    }
  }
  return "/public loads after invite login.";
});

await runCheck("public_readiness", "Public readiness API", async () => {
  const response = await request("/api/public-readiness", {
    cookie: requireCookie(),
  });
  const json = await parseJson<{
    status?: string;
    shareUrl?: string;
    nextActions?: string[];
  }>(response);
  if (response.status !== 200) {
    throw new Error(`Expected /api/public-readiness 200, got ${response.status}.`);
  }
  if (json === null) {
    throw new Error("/api/public-readiness did not return JSON.");
  }
  if (json.status !== "ready") {
    throw new Error(
      `/api/public-readiness is ${json.status ?? "unknown"}: ${
        json.nextActions?.join("; ") ?? "no next action"
      }`,
    );
  }
  if (json.shareUrl !== `${options.publicUrl}/public`) {
    throw new Error(
      `/api/public-readiness shareUrl is ${json.shareUrl ?? "<missing>"} instead of ${options.publicUrl}/public.`,
    );
  }
  return "Public readiness reports ready for the actual hosted URL.";
});

await runCheck("tester_dashboard", "Tester dashboard", async () => {
  const htmlResponse = await request("/tester-dashboard", {
    cookie: requireCookie(),
  });
  const html = await htmlResponse.text();
  if (htmlResponse.status !== 200) {
    throw new Error(`Expected /tester-dashboard 200, got ${htmlResponse.status}.`);
  }
  if (!html.includes("Tester Dashboard")) {
    throw new Error("/tester-dashboard did not render the operator/tester view.");
  }

  const apiResponse = await request("/api/tester-dashboard", {
    cookie: requireCookie(),
  });
  const json = await parseJson<TesterDashboardApi>(apiResponse);
  if (apiResponse.status !== 200 || json?.ok !== true) {
    throw new Error(`Expected /api/tester-dashboard ok, got ${apiResponse.status}.`);
  }
  latestReplayUrl = json.latestRun?.replayUrl ?? null;
  return "Tester dashboard HTML and JSON load.";
});

await runCheck("latest_replay", "Latest rendered replay", async () => {
  if (latestReplayUrl === null) {
    throw new Error("Tester dashboard did not expose a latest rendered replay.");
  }
  await verifyReplayRoute(latestReplayUrl);
  return `Latest rendered replay route opens: ${latestReplayUrl}`;
});

if (options.runMatch) {
  await runCheck("match_job", "Hosted match job", async () => {
    const response = await request("/api/jobs", {
      method: "POST",
      cookie: requireCookie(),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...proxyWarTesterSavedRosterJobDefaults,
        brain: "planner-codex-cli",
      }),
    });
    const json = await parseJson<JobResponse>(response);
    if (response.status !== 202 || json?.jobID === undefined) {
      throw new Error(`Expected /api/jobs to queue a match, got ${response.status}.`);
    }
    const completed = await waitForJob(json.jobID);
    if (completed.status !== "completed") {
      throw new Error(completed.errorSummary ?? `Match job ended as ${completed.status}.`);
    }
    const replayUrl =
      completed.replayUrl ??
      (completed.latestRunID === undefined
        ? undefined
        : `/openfront-replay/${encodeURIComponent(completed.latestRunID)}`);
    if (replayUrl === undefined) {
      throw new Error("Completed match did not expose a rendered replay URL.");
    }
    await verifyReplayRoute(replayUrl);
    createdReplayUrl = replayUrl;
    return `Queued match completed with rendered replay: ${replayUrl}`;
  });
}

const smokeStatus: SmokeReport["status"] = checks.some(
  (check) => check.status === "fail",
)
  ? "blocked"
  : "ready";
const report: SmokeReport = {
  status: smokeStatus,
  generatedAt: new Date().toISOString(),
  shareUrl: `${options.publicUrl}/public`,
  checks,
  latestReplayUrl,
  createdReplayUrl,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(formatReport(report));
}

process.exitCode = smokeStatus === "ready" ? 0 : 1;

async function runCheck(
  id: string,
  label: string,
  fn: () => Promise<string>,
): Promise<void> {
  try {
    checks.push({ id, label, status: "pass", message: await fn() });
  } catch (error) {
    checks.push({
      id,
      label,
      status: "fail",
      message: error instanceof Error ? error.message : "check failed",
    });
  }
}

async function request(
  pathOrUrl: string,
  init: RequestInit & { cookie?: CookieJar } = {},
): Promise<Response> {
  const { cookie: requestCookie, headers, ...fetchInit } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(absoluteUrl(pathOrUrl), {
      ...fetchInit,
      headers: {
        ...headersFromInit(headers),
        ...(requestCookie === undefined ? {} : { cookie: requestCookie.header }),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function verifyReplayRoute(replayUrl: string): Promise<void> {
  const response = await request(replayUrl, {
    cookie: requireCookie(),
    redirect: "manual",
  });
  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`Expected replay route redirect, got ${response.status}.`);
  }
  const location = response.headers.get("location");
  if (location === null || !location.startsWith("/ai-league-replay/")) {
    throw new Error(`Replay route redirected to ${location ?? "<missing>"}.`);
  }
  const rendered = await request(location, { cookie: requireCookie() });
  if (rendered.status !== 200) {
    throw new Error(`Rendered replay page returned ${rendered.status}.`);
  }
  const text = await rendered.text();
  if (!text.includes("OpenFront") && !text.includes("ai-league-replay")) {
    throw new Error("Rendered replay page did not look like the replay renderer.");
  }
}

async function waitForJob(jobID: string): Promise<JobResponse> {
  const deadline = Date.now() + options.matchTimeoutMs;
  let latest: JobResponse = { jobID, status: "queued" };
  while (Date.now() < deadline) {
    const response = await request(`/api/jobs/${encodeURIComponent(jobID)}`, {
      cookie: requireCookie(),
    });
    const json = await parseJson<JobResponse>(response);
    if (json !== null) {
      latest = json;
      if (json.status === "completed" || json.status === "failed") {
        return json;
      }
    }
    await sleep(5_000);
  }
  throw new Error(`Timed out waiting for match job ${jobID}; latest status was ${latest.status}.`);
}

function requireCookie(): CookieJar {
  if (cookie === null) {
    throw new Error("Invite login did not create a session.");
  }
  return cookie;
}

function cookieFromSetCookie(setCookie: string): CookieJar | null {
  const first = setCookie.split(",").find((part) => part.includes("="));
  const cookiePair = first?.split(";")[0]?.trim();
  if (cookiePair === undefined || cookiePair === "") return null;
  return {
    header: cookiePair,
    secure: /;\s*secure(?:;|$)/i.test(setCookie),
  };
}

function absoluteUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  return `${options.publicUrl}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

function headersFromInit(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function formatReport(report: SmokeReport): string {
  return [
    `ProxyWar hosted beta smoke: ${report.status}`,
    `Share URL: ${report.shareUrl}`,
    `Generated: ${report.generatedAt}`,
    "",
    "Checks:",
    ...report.checks.map(
      (check) =>
        `- ${check.status.toUpperCase()} ${check.label}: ${check.message}`,
    ),
    ...(report.createdReplayUrl === null
      ? []
      : ["", `Created replay: ${report.createdReplayUrl}`]),
  ].join("\n");
}

function parseArgs(args: string[]): SmokeOptions {
  const publicUrl = normalizePublicUrl(
    stringArg(args, "--public-url=") ?? process.env.PROXYWAR_PUBLIC_URL,
  );
  const inviteCode =
    stringArg(args, "--invite-code=") ??
    process.env.PROXYWAR_BETA_CODE ??
    process.env.PROXYWAR_BETA_PASSWORD;
  if (publicUrl === null) {
    throw new Error("Set PROXYWAR_PUBLIC_URL or pass --public-url=https://...");
  }
  if (inviteCode === undefined || inviteCode.trim() === "") {
    throw new Error("Set PROXYWAR_BETA_CODE or pass --invite-code=...");
  }
  return {
    publicUrl,
    inviteCode: inviteCode.trim(),
    timeoutMs: positiveInt(stringArg(args, "--timeout-ms="), 20_000),
    runMatch: args.includes("--run-match"),
    matchTimeoutMs: positiveInt(stringArg(args, "--match-timeout-ms="), 900_000),
    json: args.includes("--json"),
  };
}

function parseArgsOrExit(args: string[]): SmokeOptions {
  try {
    return parseArgs(args);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Hosted beta smoke configuration failed.";
    const report: SmokeReport = {
      status: "blocked",
      generatedAt: new Date().toISOString(),
      shareUrl: "<missing>/public",
      checks: [
        {
          id: "configuration",
          label: "Configuration",
          status: "fail",
          message,
        },
      ],
      latestReplayUrl: null,
      createdReplayUrl: null,
    };
    if (args.includes("--json")) {
      process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stderr.write(
        `${formatReport(report)}\n\nNext actions:\n- ${message}\n`,
      );
    }
    process.exit(1);
  }
}

function normalizePublicUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(
      "PROXYWAR_PUBLIC_URL must be a valid URL, for example https://beta.example.com.",
    );
  }
  if (parsed.pathname === "/public") {
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
  }
  return parsed.toString().replace(/\/+$/, "");
}

function stringArg(args: string[], prefix: string): string | undefined {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
