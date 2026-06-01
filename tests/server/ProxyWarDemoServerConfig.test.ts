import { describe, expect, it } from "vitest";
import {
  buildProxyWarDemoServerUrls,
  loadProxyWarDemoServerNetworkConfig,
  validateRemoteBetaInviteConfig,
} from "../../src/server/agents/ProxyWarDemoServerConfig";

describe("ProxyWarDemoServerConfig", () => {
  it("keeps localhost-only serving as the default", () => {
    const config = loadProxyWarDemoServerNetworkConfig({});
    const urls = buildProxyWarDemoServerUrls(config, {});

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 8787,
      publicUrl: null,
    });
    expect(urls.localUrl).toBe("http://127.0.0.1:8787");
    expect(urls.lanUrls).toEqual([]);
  });

  it("prints LAN URLs only when explicitly bound to all interfaces", () => {
    const config = loadProxyWarDemoServerNetworkConfig({
      AI_LEAGUE_DEMO_HOST: "0.0.0.0",
      AI_LEAGUE_DEMO_PORT: "8899",
      PROXYWAR_PUBLIC_URL: "https://beta.example.test/",
    });
    const urls = buildProxyWarDemoServerUrls(config, {
      en0: [
        {
          address: "192.168.1.42",
          family: "IPv4",
          internal: false,
          cidr: "192.168.1.42/24",
          mac: "00:00:00:00:00:00",
          netmask: "255.255.255.0",
          scopeid: 0,
        },
      ],
      lo0: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          cidr: "127.0.0.1/8",
          mac: "00:00:00:00:00:00",
          netmask: "255.0.0.0",
          scopeid: 0,
        },
      ],
    });

    expect(urls.listenUrl).toBe("http://0.0.0.0:8899");
    expect(urls.localUrl).toBe("http://127.0.0.1:8899");
    expect(urls.lanUrls).toEqual(["http://192.168.1.42:8899"]);
    expect(urls.publicUrl).toBe("https://beta.example.test");
  });

  it("warns on missing, short, or default remote invite codes", () => {
    expect(validateRemoteBetaInviteConfig({ inviteCode: null })).toContain(
      "PROXYWAR_BETA_CODE is required for remote beta access.",
    );
    expect(validateRemoteBetaInviteConfig({ inviteCode: "short" })).toContain(
      "Use an invite code with at least 8 characters.",
    );
    expect(
      validateRemoteBetaInviteConfig({ inviteCode: "frontier-beta" }),
    ).toContain("Do not use the default local invite code for remote friend access.");
    expect(
      validateRemoteBetaInviteConfig({
        inviteCode: "frontier-beta",
        allowDefaultCode: true,
      }),
    ).not.toContain(
      "Do not use the default local invite code for remote friend access.",
    );
  });
});
