import {
  assertExternalAgentEndpointAllowed,
  fetchExternalAgentWithPolicy,
  normalizeExternalAgentEndpointUrl,
} from "./ExternalAgentNetworkPolicy";
import { CreateOpenFrontierNationInput } from "./OpenFrontierNationRegistry";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenFrontierAgentCardInput {
  cardUrl: unknown;
  timeoutMs?: unknown;
  fetchFn?: FetchLike;
}

export interface NormalizedOpenFrontierAgentCardInput {
  cardUrl: string;
  timeoutMs: number;
  fetchFn?: FetchLike;
}

export interface ParsedOpenFrontierAgentCard {
  cardUrl: string;
  title: string | null;
  nationInput: CreateOpenFrontierNationInput;
  warnings: string[];
}

const maxCardBytes = 64 * 1024;
const publicSecretFields = new Set([
  "token",
  "bearertoken",
  "endpointtoken",
  "endpoint_token",
  "endpointtokenenv",
  "endpoint_token_env",
  "tokenenv",
  "token_env",
  "tokensecret",
  "token_secret",
  "apikey",
  "api_key",
  "authorization",
]);

export function normalizeOpenFrontierAgentCardInput(
  input: OpenFrontierAgentCardInput,
): NormalizedOpenFrontierAgentCardInput {
  if (typeof input.cardUrl !== "string") {
    throw new Error("Agent Card URL must be text");
  }
  const cardUrl = normalizeExternalAgentEndpointUrl(input.cardUrl).url;
  return {
    cardUrl,
    timeoutMs: normalizeTimeoutMs(input.timeoutMs),
    ...(input.fetchFn !== undefined ? { fetchFn: input.fetchFn } : {}),
  };
}

export async function fetchAndParseOpenFrontierAgentCard(
  input: NormalizedOpenFrontierAgentCardInput,
): Promise<ParsedOpenFrontierAgentCard> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const policyOptions = {
      allowPrivateNetwork:
        process.env.OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS === "true",
      maxResponseBytes: maxCardBytes,
    };
    await assertExternalAgentEndpointAllowed(input.cardUrl, policyOptions);
    const init: RequestInit = {
      method: "GET",
      headers: { accept: "text/markdown,text/plain,application/json;q=0.8,*/*;q=0.2" },
      redirect: "manual",
      signal: controller.signal,
    };
    const response =
      input.fetchFn === undefined
        ? await fetchExternalAgentWithPolicy(input.cardUrl, init, policyOptions)
        : await input.fetchFn(input.cardUrl, init);
    if (!response.ok) {
      throw new Error(`Agent Card returned HTTP ${response.status}`);
    }
    const text = await boundedText(response, maxCardBytes);
    return parseOpenFrontierAgentCardMarkdown(text, input.cardUrl);
  } catch (error) {
    if (isAbortError(error)) {
      throw errorWithCause(
        `Agent Card fetch timed out after ${input.timeoutMs}ms`,
        error,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseOpenFrontierAgentCardMarkdown(
  markdown: string,
  cardUrl = "agent-card.md",
): ParsedOpenFrontierAgentCard {
  if (new TextEncoder().encode(markdown).byteLength > maxCardBytes) {
    throw new Error("Agent Card is too large");
  }
  const parsedFields = parseCardFields(markdown, cardUrl);
  const fields = parsedFields.fields;
  for (const key of Object.keys(fields)) {
    if (publicSecretFields.has(key.toLowerCase())) {
      throw new Error(
        "Agent Card must not contain bearer tokens or secret references. Paste beta-only tokens separately.",
      );
    }
  }
  const agentName = firstString(fields, ["agentName", "name", "nationName"]);
  const profile = firstString(fields, ["profile"]);
  const doctrine = firstString(fields, ["doctrine"]) ?? "balanced";
  const endpointUrl = firstString(fields, ["endpointUrl", "endpoint", "url"]);
  const endpointTimeoutMs = firstString(fields, [
    "endpointTimeoutMs",
    "timeoutMs",
    "decisionTimeoutMs",
  ]);
  const personality =
    firstString(fields, ["personality", "description", "note"]) ??
    firstParagraph(markdown) ??
    "Imported from an Open Frontier Agent Card.";
  const policyChangelog = firstString(fields, [
    "policyChangelog",
    "changelog",
    "policyChanges",
    "latestPolicyChange",
  ]);

  const missing = [
    agentName === undefined ? "agentName" : null,
    profile === undefined ? "profile" : null,
    endpointUrl === undefined ? "endpointUrl" : null,
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    throw new Error(`Agent Card is missing ${missing.join(", ")}`);
  }
  const normalizedEndpointUrl = normalizeAgentCardEndpointUrl(endpointUrl);

  const warnings: string[] = [...parsedFields.warnings];
  if (!cardUrl.endsWith(".md")) {
    warnings.push("Agent Card URL does not end in .md; it was still parsed.");
  }

  return {
    cardUrl,
    title: firstMarkdownTitle(markdown),
    nationInput: {
      agentMode: "external-http",
      agentName,
      profile,
      doctrine,
      personality,
      ...(policyChangelog !== undefined ? { policyChangelog } : {}),
      endpointUrl: normalizedEndpointUrl,
      ...(endpointTimeoutMs !== undefined ? { endpointTimeoutMs } : {}),
    },
    warnings,
  };
}

function normalizeAgentCardEndpointUrl(endpointUrl: string | undefined): string {
  if (endpointUrl === undefined) {
    throw new Error("Agent Card is missing endpointUrl");
  }
  let parsed: URL;
  try {
    parsed = normalizeExternalAgentEndpointUrl(endpointUrl).parsed;
  } catch {
    throw new Error(
      "Agent Card endpointUrl must be a valid http or https decision endpoint URL",
    );
  }
  const lowerPath = parsed.pathname.toLowerCase();
  if (
    lowerPath.endsWith(".md") ||
    lowerPath.includes("agent-card") ||
    lowerPath.endsWith("/health")
  ) {
    throw new Error(
      "Agent Card endpointUrl must point to the POST decision endpoint, usually /open-frontier/decide, not /agent-card.md or /health.",
    );
  }
  return parsed.toString();
}

function parseCardFields(
  markdown: string,
  cardUrl: string,
): { fields: Record<string, string>; warnings: string[] } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (normalized.startsWith("---\n")) {
    return { fields: parseFrontmatter(markdown), warnings: [] };
  }
  return inferLooseAgentCardFields(markdown, cardUrl);
}

function inferLooseAgentCardFields(
  markdown: string,
  cardUrl: string,
): { fields: Record<string, string>; warnings: string[] } {
  const title = firstMarkdownTitle(markdown) ?? hostLabel(cardUrl);
  const endpointUrl = inferEndpointUrl(markdown, cardUrl);
  if (endpointUrl === null) {
    throw new Error(
      "Agent Card is missing YAML frontmatter and no decision endpoint could be inferred. Add frontmatter with agentName, profile, and endpointUrl.",
    );
  }
  return {
    fields: {
      agentName: title,
      profile: inferProfile(markdown),
      doctrine: "balanced",
      endpointUrl,
      personality:
        firstParagraph(markdown) ??
        "Imported from an Open Frontier Agent Card without frontmatter.",
    },
    warnings: [
      "Agent Card did not include YAML frontmatter; inferred agentName/profile/endpointUrl from markdown. Add frontmatter for reliable imports.",
    ],
  };
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("Agent Card must start with YAML-style frontmatter");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("Agent Card frontmatter is missing closing ---");
  }
  const frontmatter = normalized.slice(4, end).split("\n");
  const fields: Record<string, string> = {};
  for (const line of frontmatter) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`Agent Card frontmatter line is invalid: ${trimmed}`);
    }
    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1).trim());
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(`Agent Card field is invalid: ${key}`);
    }
    fields[key] = value;
  }
  return fields;
}

function inferProfile(markdown: string): string {
  const normalized = markdown.toLowerCase();
  for (const profile of [
    "aggressive",
    "defensive",
    "diplomatic",
    "opportunistic",
  ]) {
    if (normalized.includes(profile)) return profile;
  }
  return "opportunistic";
}

function inferEndpointUrl(markdown: string, cardUrl: string): string | null {
  const explicitEndpoint = absoluteUrls(markdown).find((url) =>
    url.pathname.endsWith("/open-frontier/decide"),
  );
  if (explicitEndpoint !== undefined) {
    return explicitEndpoint.toString();
  }
  const endpointPath = markdown.includes("/open-frontier/decide")
    ? "/open-frontier/decide"
    : null;
  if (endpointPath === null) return null;
  const publicBase =
    absoluteUrls(markdown).find((url) => url.protocol === "https:") ??
    urlOrNull(cardUrl);
  if (publicBase === null) return null;
  return new URL(endpointPath, publicBase.origin).toString();
}

function absoluteUrls(markdown: string): URL[] {
  const matches = markdown.match(/https:\/\/[^\s<>"')]+/g) ?? [];
  return matches
    .map((value) => value.replace(/[.,;:]+$/, ""))
    .map((value) => urlOrNull(value))
    .filter((value): value is URL => value !== null);
}

function hostLabel(cardUrl: string): string {
  const url = urlOrNull(cardUrl);
  return url?.hostname.split(".")[0] ?? "External Frontier Agent";
}

function urlOrNull(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function firstString(
  fields: Record<string, string>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function firstMarkdownTitle(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

function firstParagraph(markdown: string): string | null {
  const body = markdown.replace(/^---[\s\S]*?\n---\s*/, "");
  for (const block of body.split(/\n\s*\n/)) {
    const cleaned = block
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned !== "") return cleaned.slice(0, 240);
  }
  return null;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error("Agent Card is too large");
  }
  return text;
}

function normalizeTimeoutMs(value: unknown): number {
  if (value === undefined || value === null || value === "") return 5_000;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 250 || parsed > 30_000) {
    throw new Error("Agent Card timeout must be 250-30000 ms");
  }
  return parsed;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (error instanceof Error && error.name === "AbortError");
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}
