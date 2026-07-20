import {
  createReplayPremiereTrustedProxyAddressResolver,
  REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
  type ReplayPremiereClientAddressRequest,
} from "../../../src/server/replay-premiere/ReplayPremiereClientAddress";

describe("ReplayPremiere trusted proxy client address", () => {
  function request(
    remoteAddress: string | undefined,
    headers: ReplayPremiereClientAddressRequest["headers"] = {},
  ): ReplayPremiereClientAddressRequest {
    return { socket: { remoteAddress }, headers };
  }

  test("resolves a trusted proxy chain from the first untrusted hop", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: [
        ...REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
        "10.0.0.7",
      ],
    });

    expect(
      resolve(
        request("127.0.0.1", {
          "x-forwarded-for": "198.51.100.23, 10.0.0.7",
        }),
      ),
    ).toBe("198.51.100.23");
  });

  test("rejects one-hop and multi-hop all-trusted XFF chains", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: [
        ...REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
        "10.0.0.7",
      ],
    });

    expect(
      resolve(
        request("127.0.0.1", {
          "x-forwarded-for": "127.0.0.1",
        }),
      ),
    ).toBeNull();
    expect(
      resolve(
        request("127.0.0.1", {
          "x-forwarded-for": "127.0.0.1, 10.0.0.7",
        }),
      ),
    ).toBeNull();
  });

  test("prefers the edge-authenticated Cloudflare address over XFF", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
    });

    expect(
      resolve(
        request("127.0.0.1", {
          "cf-connecting-ip": "2001:DB8::5",
          "x-forwarded-for": "192.0.2.99, 198.51.100.8",
        }),
      ),
    ).toBe("2001:db8::5");
  });

  test("uses a direct client's socket address", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
    });

    expect(resolve(request("203.0.113.41"))).toBe("203.0.113.41");
  });

  test("ignores spoofed forwarding headers from an untrusted peer", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
    });

    expect(
      resolve(
        request("203.0.113.41", {
          "cf-connecting-ip": "198.51.100.90",
          "x-forwarded-for": "192.0.2.10",
        }),
      ),
    ).toBe("203.0.113.41");
  });

  test.each([
    { "cf-connecting-ip": "not-an-ip" },
    { "cf-connecting-ip": "198.51.100.1, 198.51.100.2" },
    { "cf-connecting-ip": ["198.51.100.1", "198.51.100.2"] },
    { "x-forwarded-for": "198.51.100.1, unknown" },
    { "x-forwarded-for": ["198.51.100.1", "198.51.100.2"] },
  ])(
    "fails closed on malformed or ambiguous trusted headers: %o",
    (headers) => {
      const resolve = createReplayPremiereTrustedProxyAddressResolver({
        trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
      });

      expect(resolve(request("127.0.0.1", headers))).toBeNull();
    },
  );

  test("recognizes IPv4-mapped loopback and rejects a headerless trusted peer", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
    });

    expect(
      resolve(
        request("::ffff:127.0.0.1", {
          "cf-connecting-ip": "198.51.100.55",
        }),
      ),
    ).toBe("198.51.100.55");
    expect(resolve(request("::ffff:127.0.0.1"))).toBeNull();
    expect(resolve(request("::ffff:7f00:1"))).toBeNull();
  });

  test("canonicalizes equivalent IPv6 spellings to one bucket address", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
    });

    const expanded = resolve(
      request("127.0.0.1", {
        "cf-connecting-ip": "2001:0DB8:0000:0000:0000:0000:0000:0001",
      }),
    );
    const compressed = resolve(
      request("127.0.0.1", {
        "cf-connecting-ip": "2001:db8::1",
      }),
    );
    expect(expanded).toBe("2001:db8::1");
    expect(compressed).toBe(expanded);
  });

  test("canonicalizes dotted and hexadecimal IPv4-mapped forms to IPv4", () => {
    const resolve = createReplayPremiereTrustedProxyAddressResolver({
      trustedProxyAddresses: REPLAY_PREMIERE_LOOPBACK_PROXY_ADDRESSES,
    });

    const dotted = resolve(
      request("127.0.0.1", {
        "cf-connecting-ip": "::ffff:203.0.113.9",
      }),
    );
    const hexadecimal = resolve(
      request("127.0.0.1", {
        "cf-connecting-ip": "::ffff:cb00:7109",
      }),
    );
    expect(dotted).toBe("203.0.113.9");
    expect(hexadecimal).toBe(dotted);
  });

  test("rejects invalid trusted-proxy configuration at startup", () => {
    expect(() =>
      createReplayPremiereTrustedProxyAddressResolver({
        trustedProxyAddresses: ["localhost"],
      }),
    ).toThrow("invalid_replay_premiere_trusted_proxy_address");
  });
});
