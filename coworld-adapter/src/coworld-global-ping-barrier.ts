/**
 * Keeps a fast-finishing game alive just long enough for Coworld's global
 * protocol sentinel to send its RFC 6455 Ping. `ws` answers the Ping with the
 * matching Pong automatically; this barrier only prevents episode teardown
 * from winning the race immediately after the first global state frame.
 */
export class CoworldGlobalPingBarrier {
  private static readonly PONG_FLUSH_GRACE_MS = 100;
  private nextConnectionID = 1;
  private readonly connectedSockets = new Map<number, boolean>();
  private readonly waiters = new Set<() => void>();

  connected(): number {
    const connectionID = this.nextConnectionID;
    this.nextConnectionID += 1;
    this.connectedSockets.set(connectionID, false);
    return connectionID;
  }

  disconnected(connectionID: number): void {
    this.connectedSockets.delete(connectionID);
    this.resolveWaiters();
  }

  observedPing(connectionID: number): void {
    if (this.connectedSockets.has(connectionID)) {
      this.connectedSockets.set(connectionID, true);
      this.resolveWaiters();
    }
  }

  async waitForPingOrGrace(timeoutMs = 2_000): Promise<void> {
    if (this.connectedSockets.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      let pongFlushTimeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        clearTimeout(graceTimeout);
        clearTimeout(hardTimeout);
        if (pongFlushTimeout !== null) {
          clearTimeout(pongFlushTimeout);
        }
        this.waiters.delete(evaluate);
        resolve();
      };
      const evaluate = (): void => {
        if (this.connectedSockets.size === 0) {
          finish();
          return;
        }
        const pingObserved = [...this.connectedSockets.values()].some(Boolean);
        if (!pingObserved && pongFlushTimeout !== null) {
          clearTimeout(pongFlushTimeout);
          pongFlushTimeout = null;
        }
        if (pongFlushTimeout === null && pingObserved) {
          // `ws` queues the matching Pong before emitting `ping`, but the
          // socket write is asynchronous. Keep the connection alive for one
          // small bounded flush window so hosted certification can observe the
          // Pong before teardown starts.
          pongFlushTimeout = setTimeout(
            finish,
            CoworldGlobalPingBarrier.PONG_FLUSH_GRACE_MS,
          );
        }
      };
      const graceTimeout = setTimeout(() => {
        if (pongFlushTimeout === null) {
          finish();
        }
      }, timeoutMs);
      const hardTimeout = setTimeout(
        finish,
        timeoutMs + CoworldGlobalPingBarrier.PONG_FLUSH_GRACE_MS,
      );

      this.waiters.add(evaluate);
      evaluate();
    });
  }

  private resolveWaiters(): void {
    for (const resolve of [...this.waiters]) {
      resolve();
    }
  }
}
