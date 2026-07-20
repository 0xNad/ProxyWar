import net from "net";

const CF_CONNECTING_IP_HEADER = "cf-connecting-ip";
const X_FORWARDED_FOR_HEADER = "x-forwarded-for";
const MAX_FORWARDED_HEADER_BYTES = 2_048;
const MAX_FORWARDED_HOPS = 16;

export const REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES = [
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
] as const;

export interface ReplayPremiereClientAddressRequest {
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  socket: {
    remoteAddress?: string;
  };
}

export type ReplayPremiereClientAddressResolver = (
  request: ReplayPremiereClientAddressRequest,
) => string | null;

export interface ReplayPremiereTrustedProxyAddressOptions {
  /** Exact transport peers which are allowed to assert forwarding headers. */
  trustedProxyAddresses: readonly string[];
}

/**
 * Resolves the requester address across an explicitly trusted reverse-proxy
 * boundary. Forwarding headers from every other socket peer are ignored.
 * Invalid or ambiguous forwarding data from a trusted peer fails closed.
 */
export function createReplayPremiereTrustedProxyAddressResolver(
  options: ReplayPremiereTrustedProxyAddressOptions,
): ReplayPremiereClientAddressResolver {
  const trustedProxyAddresses = new Set(
    options.trustedProxyAddresses.map((address) => {
      const normalized = normalizeIpAddress(address);
      if (normalized === null) {
        throw new Error("invalid_replay_premiere_trusted_proxy_address");
      }
      return normalized;
    }),
  );

  return (request) => {
    const peerAddress = normalizeIpAddress(request.socket.remoteAddress);
    if (peerAddress === null) return null;

    if (!trustedProxyAddresses.has(peerAddress)) {
      return peerAddress;
    }

    const cloudflareAddress = parseSingleForwardedAddress(
      request.headers[CF_CONNECTING_IP_HEADER],
    );
    if (cloudflareAddress.kind === "invalid") return null;
    if (cloudflareAddress.kind === "address") {
      return cloudflareAddress.address;
    }

    const forwardedChain = parseForwardedForChain(
      request.headers[X_FORWARDED_FOR_HEADER],
    );
    if (forwardedChain === null) return null;
    if (forwardedChain.length === 0) return null;

    // Walk toward the public client. Every skipped hop must itself have been
    // explicitly trusted; the first untrusted hop is the requester address.
    for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
      const address = forwardedChain[index];
      if (address === undefined) return null;
      if (!trustedProxyAddresses.has(address)) return address;
    }
    return null;
  };
}

function parseSingleForwardedAddress(
  value: string | readonly string[] | undefined,
):
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "address"; address: string } {
  if (value === undefined) return { kind: "absent" };
  if (typeof value !== "string" || value.length > MAX_FORWARDED_HEADER_BYTES) {
    return { kind: "invalid" };
  }
  const text = value.trim();
  if (text === "" || text.includes(",")) return { kind: "invalid" };
  const address = normalizeIpAddress(text);
  return address === null ? { kind: "invalid" } : { kind: "address", address };
}

function parseForwardedForChain(
  value: string | readonly string[] | undefined,
): readonly string[] | null {
  if (value === undefined) return [];
  if (typeof value !== "string" || value.length > MAX_FORWARDED_HEADER_BYTES) {
    return null;
  }
  const entries = value.split(",");
  if (entries.length === 0 || entries.length > MAX_FORWARDED_HOPS) return null;
  const addresses: string[] = [];
  for (const entry of entries) {
    const address = normalizeIpAddress(entry);
    if (address === null) return null;
    addresses.push(address);
  }
  return addresses;
}

function normalizeIpAddress(value: string | undefined): string | null {
  if (value === undefined) return null;
  const address = value.trim();
  const family = net.isIP(address);
  if (family === 0) return null;
  if (family === 4) return address;

  let canonicalIpv6: string;
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
    canonicalIpv6 = hostname.slice(1, -1);
  } catch {
    return null;
  }

  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(
    canonicalIpv6,
  );
  if (mappedIpv4 !== null) {
    const high = Number.parseInt(mappedIpv4[1], 16);
    const low = Number.parseInt(mappedIpv4[2], 16);
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
  }
  return canonicalIpv6;
}
