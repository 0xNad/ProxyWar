/**
 * Tiny deterministic PRNG (mulberry32). Ported verbatim from the prior
 * single-player engine's `engine/prng.ts` — self-contained so the crowd
 * simulator never depends on `src/core`'s PseudoRandom or on `Math.random`.
 * State is a single 32-bit integer, so it serialises cleanly if a caller
 * ever wants to persist/resume a run — restoring the state reproduces the
 * exact future sequence.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    // Coerce to a 32-bit unsigned integer.
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    if (max < min) {
      return min;
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  getState(): number {
    return this.state >>> 0;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }
}
