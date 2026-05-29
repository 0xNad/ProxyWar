import dns from "dns/promises";
import http from "http";
import https from "https";
import net from "net";

export interface ExternalAgentNetworkPolicyOptions {
  allowPrivateNetwork?: boolean;
  requireHttpsForPublic?: boolean;
  maxResponseBytes?: number;
  resolveAddresses?: ExternalAgentAddressResolver;
}

export interface NormalizedExternalAgentEndpoint {
  url: string;
  parsed: URL;
}

export interface ExternalAgentResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ExternalAgentAddressResolver = (
  hostname: string,
) => Promise<ExternalAgentResolvedAddress[]>;

export interface ExternalAgentEndpointPolicyResult {
  url: string;
  hostname: string;
  protocol: string;
  addresses: ExternalAgentResolvedAddress[];
  hasPrivateOrReservedAddress: boolean;
  allowed: boolean;
  failureReason?: string;
}

export const defaultExternalAgentMaxResponseBytes = 16_384;

export function normalizeExternalAgentEndpointUrl(
  value: string,
): NormalizedExternalAgentEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("External agent endpoint must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("External agent endpoint must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("External agent endpoint must not include credentials");
  }
  parsed.hash = "";
  return { url: parsed.toString(), parsed };
}

export async function assertExternalAgentEndpointAllowed(
  endpoint: string | URL,
  options: ExternalAgentNetworkPolicyOptions = {},
): Promise<void> {
  const result = await evaluateExternalAgentEndpointPolicy(endpoint, options);
  if (!result.allowed) {
    throw new Error(result.failureReason ?? "External agent endpoint is not allowed");
  }
}

export async function evaluateExternalAgentEndpointPolicy(
  endpoint: string | URL,
  options: ExternalAgentNetworkPolicyOptions = {},
): Promise<ExternalAgentEndpointPolicyResult> {
  const url = typeof endpoint === "string" ? new URL(endpoint) : endpoint;
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const requireHttpsForPublic = options.requireHttpsForPublic !== false;
  const addresses = await resolveEndpointAddresses(url.hostname, options);
  const hasPrivateAddress = addresses.some((address) =>
    isPrivateOrReservedAddress(address.address),
  );
  if (!allowPrivateNetwork && hasPrivateAddress) {
    return {
      url: url.toString(),
      hostname: url.hostname,
      protocol: url.protocol,
      addresses,
      hasPrivateOrReservedAddress: hasPrivateAddress,
      allowed: false,
      failureReason:
        "External agent endpoint resolves to a private, local, or reserved network address",
    };
  }
  if (
    requireHttpsForPublic &&
    url.protocol !== "https:" &&
    !(allowPrivateNetwork && hasPrivateAddress)
  ) {
    return {
      url: url.toString(),
      hostname: url.hostname,
      protocol: url.protocol,
      addresses,
      hasPrivateOrReservedAddress: hasPrivateAddress,
      allowed: false,
      failureReason: "External agent endpoint must use https",
    };
  }
  return {
    url: url.toString(),
    hostname: url.hostname,
    protocol: url.protocol,
    addresses,
    hasPrivateOrReservedAddress: hasPrivateAddress,
    allowed: true,
  };
}

export async function fetchExternalAgentWithPolicy(
  endpoint: string | URL,
  init: RequestInit,
  options: ExternalAgentNetworkPolicyOptions = {},
): Promise<Response> {
  const url = typeof endpoint === "string" ? new URL(endpoint) : endpoint;
  const policy = await evaluateExternalAgentEndpointPolicy(url, options);
  if (!policy.allowed) {
    throw new Error(policy.failureReason ?? "External agent endpoint is not allowed");
  }
  if (policy.addresses.length === 0) {
    throw new Error("External agent endpoint did not resolve to any address");
  }
  const pinnedAddress = policy.addresses[0];
  return requestWithPinnedAddress(url, init, pinnedAddress, {
    maxResponseBytes: options.maxResponseBytes ?? defaultExternalAgentMaxResponseBytes,
  });
}

async function requestWithPinnedAddress(
  url: URL,
  init: RequestInit,
  pinnedAddress: ExternalAgentResolvedAddress,
  options: { maxResponseBytes: number },
): Promise<Response> {
  if (init.redirect !== undefined && init.redirect !== "manual") {
    throw new Error("External agent redirects are disabled");
  }
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("External agent request body must be a string");
  }
  const headers = headersFromInit(init.headers);
  const transport = url.protocol === "https:" ? https : http;
  const port =
    url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "POST",
        headers,
        servername: url.hostname,
        lookup: (_hostname, lookupOptions, callback) => {
          if (
            typeof lookupOptions === "object" &&
            lookupOptions !== null &&
            "all" in lookupOptions &&
            lookupOptions.all === true
          ) {
            callback(null, [pinnedAddress]);
            return;
          }
          callback(null, pinnedAddress.address, pinnedAddress.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > options.maxResponseBytes) {
            request.destroy(
              new Error(
                `external agent response exceeds ${options.maxResponseBytes} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value !== undefined) {
              responseHeaders.set(name, String(value));
            }
          }
          resolve(
            new Response(body, {
              status: response.statusCode ?? 502,
              statusText: response.statusMessage,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on("error", reject);
    init.signal?.addEventListener("abort", () => {
      request.destroy(new DOMException("aborted", "AbortError"));
    });
    if (typeof init.body === "string") {
      request.write(init.body);
    }
    request.end();
  });
}

export async function readExternalAgentResponseText(
  response: Response,
  maxBytes = defaultExternalAgentMaxResponseBytes,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new Error(`external agent response exceeds ${maxBytes} bytes`);
  }
  const contentType = response.headers.get("content-type");
  if (
    contentType !== null &&
    !contentType.toLowerCase().includes("json") &&
    !contentType.toLowerCase().startsWith("text/plain")
  ) {
    throw new Error(`external agent response content-type is not JSON`);
  }
  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`external agent response exceeds ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`external agent response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function resolveEndpointAddresses(
  hostname: string,
  options: ExternalAgentNetworkPolicyOptions,
): Promise<ExternalAgentResolvedAddress[]> {
  if (net.isIP(hostname) !== 0) {
    return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  }
  if (hostname.toLowerCase() === "localhost") {
    return [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ];
  }
  if (options.resolveAddresses !== undefined) {
    return normalizeResolvedAddresses(await options.resolveAddresses(hostname));
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: false });
  return normalizeResolvedAddresses(records);
}

function normalizeResolvedAddresses(
  records: Array<{ address: string; family: number }>,
): ExternalAgentResolvedAddress[] {
  const seen = new Set<string>();
  return records
    .filter(
      (record): record is ExternalAgentResolvedAddress =>
        (record.family === 4 || record.family === 6) &&
        net.isIP(record.address) === record.family,
    )
    .filter((record) => {
      const key = `${record.family}:${record.address}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function headersFromInit(headers: HeadersInit | undefined): http.OutgoingHttpHeaders {
  if (headers === undefined) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return headers;
}

function isPrivateOrReservedAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) {
    return isPrivateOrReservedAddress(address.slice("::ffff:".length));
  }
  if (net.isIP(address) === 4) {
    return isPrivateOrReservedIPv4(address);
  }
  if (net.isIP(address) === 6) {
    return isPrivateOrReservedIPv6(address);
  }
  return true;
}

function isPrivateOrReservedIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map((part) => Number(part));
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateOrReservedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("ff")
  );
}
