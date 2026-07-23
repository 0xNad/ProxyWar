import { z } from "zod";

const proxyWarClipGenerationCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    premiereGenerationEnabled: z.boolean(),
    leagueGenerationEnabled: z.boolean(),
  })
  .strict();

export type ProxyWarClipGenerationCapabilities = z.infer<
  typeof proxyWarClipGenerationCapabilitiesSchema
>;

const FAIL_CLOSED: ProxyWarClipGenerationCapabilities = {
  schemaVersion: 1,
  premiereGenerationEnabled: false,
  leagueGenerationEnabled: false,
};

/**
 * Reads the process-level clip-generation capability. The UI deliberately
 * fails closed: an older server, a transport failure, a non-200 response, or
 * a malformed payload hides generation affordances instead of presenting a
 * button whose POST route cannot exist.
 */
export async function readProxyWarClipGenerationCapabilities(
  fetchImpl: typeof fetch | undefined = globalThis.fetch,
): Promise<ProxyWarClipGenerationCapabilities> {
  try {
    if (typeof fetchImpl !== "function") {
      return { ...FAIL_CLOSED };
    }
    const response = await fetchImpl("/api/clip-capabilities", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      return { ...FAIL_CLOSED };
    }
    const parsed = proxyWarClipGenerationCapabilitiesSchema.safeParse(
      await response.json(),
    );
    return parsed.success ? parsed.data : { ...FAIL_CLOSED };
  } catch {
    return { ...FAIL_CLOSED };
  }
}
