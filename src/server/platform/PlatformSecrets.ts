/**
 * Platform-only secret material: the private state root and HMAC signing
 * key for `proxywar.xyz`'s own session cookie
 * (`PlatformAccountSecurity`). Deliberately its own durable root, which must
 * outlive every premiere and origin restart and never share a lifecycle with
 * replay-private state.
 *
 * Key loading itself is not reimplemented here:
 * `loadOrCreateReplayPremiereGuestHmacKey` (re-exported below as
 * `loadOrCreatePlatformHmacKey`) is already a generic "securely
 * load-or-create a random file-backed key, refusing an unsafe root"
 * primitive with nothing premiere-specific in its signature — callers
 * point it at this module's own root/env var instead.
 */
import os from "node:os";
import path from "node:path";

export const PLATFORM_STATE_ROOT_ENV = "PROXYWAR_PLATFORM_STATE_ROOT" as const;
export const PLATFORM_HMAC_HEX_ENV = "PROXYWAR_PLATFORM_HMAC_KEY_HEX" as const;

export function resolvePlatformPrivateStateRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[PLATFORM_STATE_ROOT_ENV]?.trim();
  const selected =
    configured === undefined || configured === ""
      ? path.join(
          homeDirectory,
          "Library",
          "Application Support",
          "ProxyWar",
          "storage",
          "platform-private",
        )
      : configured;
  const resolved = path.resolve(selected);
  if (
    !path.isAbsolute(selected) ||
    resolved === path.parse(resolved).root ||
    resolved === path.resolve(homeDirectory)
  ) {
    throw new Error(`invalid_platform_state_root: ${selected}`);
  }
  return resolved;
}

export { loadOrCreateReplayPremiereGuestHmacKey as loadOrCreatePlatformHmacKey } from "../replay-premiere/ReplayPremiereSecrets";
