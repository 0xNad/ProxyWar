import http from "http";
import { describe, expect, it } from "vitest";
import {
  assertExternalAgentEndpointAllowed,
  evaluateExternalAgentEndpointPolicy,
  fetchExternalAgentWithPolicy,
  normalizeExternalAgentEndpointUrl,
  readExternalAgentResponseText,
} from "../../src/server/agents/ExternalAgentNetworkPolicy";

describe("ExternalAgentNetworkPolicy", () => {
  it("rejects localhost/private endpoints by default", async () => {
    await expect(
      assertExternalAgentEndpointAllowed("http://127.0.0.1:7777/decide"),
    ).rejects.toThrow(/private, local, or reserved/);
    await expect(
      assertExternalAgentEndpointAllowed("http://localhost:7777/decide"),
    ).rejects.toThrow(/private, local, or reserved/);
    await expect(
      assertExternalAgentEndpointAllowed("http://192.168.1.10/decide"),
    ).rejects.toThrow(/private, local, or reserved/);
  });

  it("rejects documentation, benchmark, mapped, and reserved addresses", async () => {
    for (const address of [
      "192.0.2.10",
      "198.51.100.7",
      "203.0.113.5",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::ffff:127.0.0.1",
      "2001:db8::1",
      "64:ff9b::c000:0201",
    ]) {
      const host = address.includes(":") ? `[${address}]` : address;
      await expect(
        assertExternalAgentEndpointAllowed(`https://${host}/decide`),
        address,
      ).rejects.toThrow(/private, local, or reserved/);
    }
  });

  it("allows explicit local-development private endpoints", async () => {
    await expect(
      assertExternalAgentEndpointAllowed("http://127.0.0.1:7777/decide", {
        allowPrivateNetwork: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("normalizes URLs and rejects embedded credentials", () => {
    expect(
      normalizeExternalAgentEndpointUrl("https://example.com/decide#secret").url,
    ).toBe("https://example.com/decide");
    expect(() =>
      normalizeExternalAgentEndpointUrl("https://user:pass@example.com/decide"),
    ).toThrow(/must not include credentials/);
  });

  it("reports endpoint policy diagnostics without making a request", async () => {
    await expect(
      evaluateExternalAgentEndpointPolicy("https://agent.example.test/decide", {
        resolveAddresses: async () => [{ address: "10.0.0.1", family: 4 }],
      }),
    ).resolves.toMatchObject({
      allowed: false,
      hasPrivateOrReservedAddress: true,
      failureReason:
        "External agent endpoint resolves to a private, local, or reserved network address",
    });
    await expect(
      evaluateExternalAgentEndpointPolicy("https://agent.example.test/decide", {
        resolveAddresses: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
    ).resolves.toMatchObject({
      allowed: true,
      addresses: [{ address: "8.8.8.8", family: 4 }],
    });
  });

  it("performs pinned local-development requests when private endpoints are allowed", async () => {
    const server = http.createServer((request, response) => {
      expect(request.headers.host).toContain("127.0.0.1");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          selectedLegalActionId: "health-check:hold",
          reason: "Pinned request reached the endpoint.",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind to a TCP port");
      }
      const response = await fetchExternalAgentWithPolicy(
        `http://127.0.0.1:${address.port}/decide`,
        {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
          redirect: "manual",
        },
        { allowPrivateNetwork: true },
      );

      await expect(readExternalAgentResponseText(response)).resolves.toContain(
        "health-check:hold",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("performs pinned requests for resolved hostnames", async () => {
    const server = http.createServer((request, response) => {
      expect(request.headers.host).toContain("agent.example.test");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          selectedLegalActionId: "health-check:hold",
          reason: "Pinned hostname request reached the endpoint.",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    try {
      if (address === null || typeof address === "string") {
        throw new Error("server did not bind to a TCP port");
      }
      const response = await fetchExternalAgentWithPolicy(
        `http://agent.example.test:${address.port}/decide`,
        {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
          redirect: "manual",
        },
        {
          allowPrivateNetwork: true,
          resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }],
        },
      );

      await expect(readExternalAgentResponseText(response)).resolves.toContain(
        "health-check:hold",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("limits external agent response size and content type", async () => {
    await expect(
      readExternalAgentResponseText(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        16,
      ),
    ).resolves.toBe("{}");
    await expect(
      readExternalAgentResponseText(
        new Response("x".repeat(32), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        16,
      ),
    ).rejects.toThrow(/exceeds 16 bytes/);
    await expect(
      readExternalAgentResponseText(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
        16,
      ),
    ).rejects.toThrow(/content-type/);
  });
});
