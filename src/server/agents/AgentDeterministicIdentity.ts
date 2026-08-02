import { createHash } from "node:crypto";

export function deterministicAgentClientID(
  seed: string,
  namespace: string,
  index: number,
): string {
  return createHash("sha256")
    .update(`proxywar-agent-smoke-v1\0${seed}\0${namespace}\0${index}`)
    .digest("hex")
    .slice(0, 8);
}
