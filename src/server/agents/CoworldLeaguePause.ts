const COWORLD_UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/**
 * Accept only Coworld's canonical UTC timestamp form and preserve its exact
 * fractional precision. Invalid or type-drifted authority input is not a
 * pause signal.
 */
export function canonicalCoworldLeaguePauseTimestamp(
  value: unknown,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return null;
  }
  const match = COWORLD_UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const instant = new Date(parsed);
  const components = [
    instant.getUTCFullYear(),
    instant.getUTCMonth() + 1,
    instant.getUTCDate(),
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
  ];
  return components.every(
    (component, index) => component === Number(match[index + 1]),
  )
    ? value
    : null;
}
