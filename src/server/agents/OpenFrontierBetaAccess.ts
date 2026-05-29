import { createHmac, timingSafeEqual, randomUUID } from "crypto";

const DEFAULT_COOKIE_NAME = "open_frontier_beta";
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface OpenFrontierBetaAccessConfig {
  enabled: boolean;
  inviteCode: string | null;
  cookieName: string;
  sessionTtlMs: number;
  label: string;
  secureCookie: boolean;
}

export interface OpenFrontierBetaFeedbackEntry {
  feedbackID: string;
  createdAt: string;
  testerName: string | null;
  rating: "great" | "okay" | "confusing" | "broken" | null;
  runID: string | null;
  comment: string | null;
}

export function loadOpenFrontierBetaAccessConfig(
  env: Record<string, string | undefined> = process.env,
): OpenFrontierBetaAccessConfig {
  const enabled = envFlag(env.OPEN_FRONTIER_BETA_ENABLED);
  const sessionTtlMs = positiveInt(
    env.OPEN_FRONTIER_BETA_SESSION_TTL_MS,
    DEFAULT_SESSION_TTL_MS,
  );
  return {
    enabled,
    inviteCode:
      firstNonEmpty(env.OPEN_FRONTIER_BETA_CODE, env.OPEN_FRONTIER_BETA_PASSWORD) ??
      null,
    cookieName:
      firstNonEmpty(env.OPEN_FRONTIER_BETA_COOKIE_NAME) ?? DEFAULT_COOKIE_NAME,
    sessionTtlMs,
    label: firstNonEmpty(env.OPEN_FRONTIER_BETA_LABEL) ?? "Closed beta",
    secureCookie:
      envFlag(env.OPEN_FRONTIER_BETA_COOKIE_SECURE) ||
      (firstNonEmpty(env.OPEN_FRONTIER_PUBLIC_URL)?.startsWith("https://") ??
        false),
  };
}

export function createOpenFrontierBetaSessionToken(input: {
  inviteCode: string;
  issuedAtMs?: number;
}): string {
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const payload = `v1.${Math.trunc(issuedAtMs)}`;
  return `${payload}.${sign(payload, input.inviteCode)}`;
}

export function verifyOpenFrontierBetaSessionToken(input: {
  config: OpenFrontierBetaAccessConfig;
  token: string | null | undefined;
  nowMs?: number;
}): boolean {
  if (!input.config.enabled || input.config.inviteCode === null || !input.token) {
    return false;
  }
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const issuedAtMs = Number(parts[1]);
  if (!Number.isFinite(issuedAtMs)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (issuedAtMs > nowMs + MAX_CLOCK_SKEW_MS) return false;
  if (nowMs - issuedAtMs > input.config.sessionTtlMs) return false;

  const payload = `${parts[0]}.${parts[1]}`;
  return safeEqual(parts[2], sign(payload, input.config.inviteCode));
}

export function verifyOpenFrontierBetaInviteCode(
  config: OpenFrontierBetaAccessConfig,
  inviteCode: string | null | undefined,
): boolean {
  if (
    !config.enabled ||
    config.inviteCode === null ||
    inviteCode === undefined ||
    inviteCode === null
  ) {
    return false;
  }
  return safeEqual(sign("invite", inviteCode), sign("invite", config.inviteCode));
}

export function parseCookieHeader(
  cookieHeader: string | null | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (cookieHeader === null || cookieHeader === undefined) return cookies;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies[decodeURIComponent(rawName)] = decodeURIComponent(rawValue.join("="));
  }
  return cookies;
}

export function betaSessionCookieHeader(
  config: OpenFrontierBetaAccessConfig,
  token: string,
): string {
  return [
    `${encodeURIComponent(config.cookieName)}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.ceil(config.sessionTtlMs / 1000)}`,
    ...(config.secureCookie ? ["Secure"] : []),
  ].join("; ");
}

export function clearBetaSessionCookieHeader(
  config: OpenFrontierBetaAccessConfig,
): string {
  return [
    `${encodeURIComponent(config.cookieName)}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
    ...(config.secureCookie ? ["Secure"] : []),
  ].join("; ");
}

export function normalizeOpenFrontierBetaReturnTo(
  value: string | null | undefined,
): string {
  if (value === null || value === undefined) return "/public";
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    hasAsciiControlCharacter(trimmed)
  ) {
    return "/public";
  }
  if (
    trimmed === "/beta" ||
    trimmed.startsWith("/beta?") ||
    trimmed.startsWith("/api/beta/")
  ) {
    return "/public";
  }
  return trimmed;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0 && code <= 31) return true;
  }
  return false;
}

export function renderOpenFrontierBetaLoginHtml(
  config: OpenFrontierBetaAccessConfig,
  error?: string,
  returnTo?: string,
): string {
  const normalizedReturnTo = normalizeOpenFrontierBetaReturnTo(returnTo);
  const setupWarning =
    config.enabled && config.inviteCode === null
      ? `<div class="warning">This beta server needs <code>OPEN_FRONTIER_BETA_CODE</code> before testers can enter.</div>`
      : "";
  const errorHtml =
    error === undefined ? "" : `<div class="error">${escapeHtml(error)}</div>`;
  const returnHint =
    normalizedReturnTo === "/public"
      ? ""
      : `<p class="return-hint">After login, this will open <code>${escapeHtml(normalizedReturnTo)}</code>.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Frontier Beta</title>
  <style>
    :root { color-scheme: light; --ink:#132232; --muted:#64748b; --line:#d8e1eb; --panel:#fff; --paper:#f4f8fb; --accent:#176358; --bad:#9f1d35; --warn:#85610a; }
    * { box-sizing:border-box; }
    body { min-height:100vh; margin:0; display:grid; place-items:center; background:linear-gradient(135deg, #102236, #205866 58%, #1e6d64); color:var(--ink); font:15px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding:24px; }
    main { width:min(100%, 460px); background:var(--panel); border:1px solid rgba(255,255,255,.32); border-radius:10px; padding:24px; box-shadow:0 24px 70px rgba(0,0,0,.28); }
    h1 { margin:0; font-size:34px; letter-spacing:0; }
    p { color:var(--muted); margin:8px 0 18px; }
    label { display:block; color:#405166; font-weight:800; font-size:12px; margin:10px 0 5px; }
    input { width:100%; border:1px solid #cbd6e2; border-radius:6px; padding:11px; background:white; color:var(--ink); font:inherit; }
    button { width:100%; border:0; border-radius:6px; padding:12px; margin-top:14px; background:var(--accent); color:white; font:800 14px/1.2 inherit; cursor:pointer; }
    .pill { display:inline-flex; min-height:24px; padding:3px 9px; border-radius:999px; background:#e7f5ee; color:var(--accent); font-weight:800; font-size:12px; margin-bottom:10px; }
    .error, .warning { border-radius:8px; padding:10px 12px; margin-bottom:12px; font-weight:700; }
    .error { background:#fdebf0; color:var(--bad); }
    .warning { background:#fff6dc; color:var(--warn); }
    .return-hint { margin-top:-8px; font-size:13px; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  </style>
</head>
<body>
  <main>
    <span class="pill">${escapeHtml(config.label)}</span>
    <h1>Open Frontier</h1>
    <p>Enter your invite code to create AI nations, run matches, and watch autonomous strategy replays.</p>
    ${setupWarning}
    ${errorHtml}
    ${returnHint}
    <form method="post" action="/api/beta/login">
      <input type="hidden" name="returnTo" value="${escapeHtml(normalizedReturnTo)}">
      <label for="inviteCode">Invite code</label>
      <input id="inviteCode" name="inviteCode" type="password" autocomplete="current-password" autofocus>
      <button type="submit">Enter Beta</button>
    </form>
  </main>
</body>
</html>`;
}

export function normalizeOpenFrontierBetaFeedback(
  input: Record<string, unknown>,
  now = new Date(),
): OpenFrontierBetaFeedbackEntry {
  const testerName = optionalText(input.testerName, 80);
  const runID = optionalText(input.runID, 160);
  const comment = optionalText(input.comment, 2_000);
  const rating = normalizeRating(input.rating);
  if (rating === null && comment === null) {
    throw new Error("feedback needs a rating or a comment");
  }
  return {
    feedbackID: randomUUID(),
    createdAt: now.toISOString(),
    testerName,
    rating,
    runID,
    comment,
  };
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, maxLength);
  return normalized === "" ? null : normalized;
}

function normalizeRating(
  value: unknown,
): OpenFrontierBetaFeedbackEntry["rating"] {
  if (typeof value !== "string") return null;
  if (
    value === "great" ||
    value === "okay" ||
    value === "confusing" ||
    value === "broken"
  ) {
    return value;
  }
  return null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
