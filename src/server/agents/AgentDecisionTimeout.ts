// Decision timers arm via queueMicrotask. The league's observation batch is
// enforced-synchronous, so a queued arm fires only after every seat's
// observation has been built: observation work never consumes a policy's
// timeout window, and direct callers keep effectively-immediate arming.
export interface DeferredDecisionTimeout {
  arm(): void;
  clear(): void;
}

export interface AbortableRequestAttempt {
  controller: AbortController;
  timeout: DeferredDecisionTimeout;
}

export function createDeferredDecisionTimeout(
  timeoutMs: number,
  onTimeout: () => void,
): DeferredDecisionTimeout {
  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  return {
    arm: () => {
      if (
        settled ||
        timeoutID !== undefined ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0
      ) {
        return;
      }
      timeoutID = setTimeout(onTimeout, timeoutMs);
    },
    clear: () => {
      settled = true;
      if (timeoutID !== undefined) {
        clearTimeout(timeoutID);
      }
    },
  };
}

export function createAbortableRequestAttempt(
  timeoutMs: number,
): AbortableRequestAttempt {
  const controller = new AbortController();
  return {
    controller,
    timeout: createDeferredDecisionTimeout(timeoutMs, () => {
      controller.abort();
    }),
  };
}

export function withDeferredDecisionTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): { promise: Promise<T>; timeout: DeferredDecisionTimeout } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      promise,
      timeout: createDeferredDecisionTimeout(timeoutMs, () => undefined),
    };
  }
  let rejectTimeout: (error: Error) => void = () => undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = createDeferredDecisionTimeout(timeoutMs, () => {
    rejectTimeout(timeoutError());
  });
  const timedPromise = Promise.race([promise, timeoutPromise]);
  void timedPromise.then(timeout.clear, timeout.clear);
  queueMicrotask(timeout.arm);
  return { promise: timedPromise, timeout };
}
