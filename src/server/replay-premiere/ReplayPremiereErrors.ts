export type ReplayPremierePublicErrorCode =
  | "PREMIERE_CAPACITY_EXCEEDED"
  | "PREMIERE_INTEGRITY_FAILURE"
  | "PREMIERE_INVALID_REQUEST"
  | "PREMIERE_SOURCE_INELIGIBLE"
  | "PREMIERE_UNAVAILABLE";

export interface ReplayPremierePublicFailure {
  error: {
    code: ReplayPremierePublicErrorCode;
  };
}

/**
 * Carries operator-only context while keeping the public response fixed and
 * path-free. Route adapters must call toPublicReplayPremiereFailure rather
 * than returning Error.message.
 */
export class ReplayPremiereError extends Error {
  public constructor(
    readonly operatorCode: string,
    readonly publicCode: ReplayPremierePublicErrorCode,
    readonly httpStatus: number,
    operatorMessage: string,
    options?: ErrorOptions,
  ) {
    super(operatorMessage, options);
    this.name = "ReplayPremiereError";
  }
}

export function toPublicReplayPremiereFailure(
  error: unknown,
): ReplayPremierePublicFailure {
  return {
    error: {
      code:
        error instanceof ReplayPremiereError
          ? error.publicCode
          : "PREMIERE_UNAVAILABLE",
    },
  };
}
