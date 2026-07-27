const MAX_ERROR_CAUSE_DEPTH = 4;
const MAX_ERROR_NAME_LENGTH = 48;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 192;
const MAX_ERROR_MESSAGE_INPUT_LENGTH = 768;

export interface ReplayPremiereErrorTelemetryEntry {
  name: string;
  code?: string;
  message: string;
}

/**
 * Preserve bounded operator diagnostics without copying stacks, filesystem
 * locations, credentials, URLs, or arbitrary object serialization into logs.
 */
export function sanitizeReplayPremiereErrorCauseChain(
  error: unknown,
): readonly ReplayPremiereErrorTelemetryEntry[] {
  const entries: ReplayPremiereErrorTelemetryEntry[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (current !== null && typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }

    entries.push(sanitizeErrorEntry(current));
    const cause = safeProperty(current, "cause");
    if (cause === undefined) break;
    current = cause;
  }

  return entries;
}

export function formatReplayPremiereErrorCauseChain(error: unknown): string {
  return JSON.stringify(sanitizeReplayPremiereErrorCauseChain(error));
}

function sanitizeErrorEntry(error: unknown): ReplayPremiereErrorTelemetryEntry {
  if (error === null) {
    return { name: "null", message: "null" };
  }
  if (typeof error !== "object" && typeof error !== "function") {
    return {
      name: sanitizeIdentifier(typeof error, "NonError", MAX_ERROR_NAME_LENGTH),
      message: sanitizeMessage(String(error)),
    };
  }

  const rawName = safeProperty(error, "name");
  const rawCode = safeProperty(error, "code");
  const rawMessage = safeProperty(error, "message");
  const entry: ReplayPremiereErrorTelemetryEntry = {
    name: sanitizeIdentifier(rawName, "Error", MAX_ERROR_NAME_LENGTH),
    message:
      typeof rawMessage === "string"
        ? sanitizeMessage(rawMessage)
        : "[message unavailable]",
  };
  if (typeof rawCode === "string" || typeof rawCode === "number") {
    entry.code = sanitizeIdentifier(
      String(rawCode),
      "[redacted]",
      MAX_ERROR_CODE_LENGTH,
    );
  }
  return entry;
}

function safeProperty(
  value: unknown,
  key: "cause" | "code" | "message" | "name",
) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, key) as unknown;
  } catch {
    return undefined;
  }
}

function sanitizeIdentifier(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.:-]+$/.test(value) ||
    /(?:api.?key|authorization|cookie|credential|password|secret|session|token)/i.test(
      value,
    )
  ) {
    return fallback;
  }
  return value.slice(0, maxLength);
}

function sanitizeMessage(message: string): string {
  let sanitized = stripControlCharacters(
    message.slice(0, MAX_ERROR_MESSAGE_INPUT_LENGTH),
  );

  // Remove whole URLs before path matching so URL paths and query credentials
  // cannot survive as partial fragments.
  sanitized = sanitized.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
    "[url]",
  );
  sanitized = sanitized.replace(
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    "[authorization redacted]",
  );
  sanitized = sanitized.replace(
    /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|passwd|authorization|cookie|session(?:id)?|credential(?:s)?)\b\s*(?:=|:)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (_match, label: string) => `${label}=[redacted]`,
  );

  // Quoted paths may contain spaces. Match them before the unquoted form.
  sanitized = sanitized.replace(
    /(["'])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)[^"'\r\n]*\1/g,
    (_match, quote: string) => `${quote}[path]${quote}`,
  );
  sanitized = sanitized.replace(
    /(^|[\s(=,:])(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)[^\s,;)"'<>]*/g,
    (_match, prefix: string) => `${prefix}[path]`,
  );
  sanitized = sanitized.replace(/[^\s,;)"'<>]*[\\/][^\s,;)"'<>]*/g, "[path]");

  // Long opaque values are more likely to be credentials than actionable
  // diagnostics. Error codes and ordinary prose remain visible separately.
  sanitized = sanitized.replace(/\b[A-Za-z0-9_+/=.-]{24,}\b/g, "[redacted]");
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  if (sanitized.length <= MAX_ERROR_MESSAGE_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function stripControlCharacters(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }
  return sanitized;
}
