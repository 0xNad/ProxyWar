/**
 * Keeps a fast-finishing game alive just long enough for Coworld's global
 * protocol sentinel to send its RFC 6455 Ping. `ws` answers the Ping with the
 * matching Pong automatically; this barrier only prevents episode teardown
 * from winning the race immediately after the first global state frame.
 */
export class CoworldGlobalPingBarrier {
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
    if (this.connectedSockets.size === 0) {
      this.resolveWaiters();
    }
  }

  observedPing(connectionID: number): void {
    if (this.connectedSockets.has(connectionID)) {
      this.connectedSockets.set(connectionID, true);
      this.resolveWaiters();
    }
  }

  async waitForPingOrGrace(timeoutMs = 2_000): Promise<void> {
    if (this.probeSatisfied()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timeout);
        this.waiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);

      this.waiters.add(finish);
      if (this.probeSatisfied()) {
        finish();
      }
    });
  }

  private probeSatisfied(): boolean {
    return (
      this.connectedSockets.size === 0 ||
      [...this.connectedSockets.values()].some((pingObserved) => pingObserved)
    );
  }

  private resolveWaiters(): void {
    for (const resolve of [...this.waiters]) {
      resolve();
    }
  }
}
