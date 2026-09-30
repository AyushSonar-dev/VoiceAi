/**
 * Circuit Breaker — System Design: Fault tolerance for external service calls
 *
 * Implements the classic three-state machine:
 *
 *   CLOSED  ──(N failures in window)──► OPEN ──(timeout)──► HALF_OPEN
 *     ▲                                                           │
 *     └─────────────── success ──────────────────────────────────┘
 *
 * CLOSED    : All calls pass through normally.
 * OPEN      : Calls fail-fast (no network call made). Saves latency + quota.
 * HALF_OPEN : One probe call is let through. Success → CLOSED; failure → OPEN.
 *
 * Used for:
 *  • AssemblyAI token-mint calls  (voice/setup)
 *  • LLM provider calls           (already has provider-level fallback, but the
 *                                  circuit breaker adds time-based fast-fail so a
 *                                  dead provider doesn't hold up every turn)
 *
 * Data structure:
 *   failureCount  : number   — rolling count in the window
 *   lastFailure   : number   — epoch-ms of most-recent failure
 *   state         : enum     — CLOSED | OPEN | HALF_OPEN
 *
 * Time-complexity: O(1) per call — no queue or sliding window array.
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** How many failures within `windowMs` trips the breaker. Default: 5 */
  failureThreshold?: number;
  /** How long (ms) the window resets failures. Default: 30 000 (30 s) */
  windowMs?: number;
  /** How long (ms) the breaker stays OPEN before probing. Default: 15 000 (15 s) */
  resetTimeoutMs?: number;
  /** Human name for log messages. */
  name?: string;
  /**
   * Which errors count toward tripping. A 400 from our own malformed request
   * means the service is up, so it must not open the circuit. Default: all.
   */
  isFailure?: (err: unknown) => boolean;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private lastFailureAt = 0;
  private lastOpenAt = 0;

  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly resetTimeoutMs: number;
  private readonly name: string;
  private readonly isFailure: (err: unknown) => boolean;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.windowMs         = opts.windowMs         ?? 30_000;
    this.resetTimeoutMs   = opts.resetTimeoutMs   ?? 15_000;
    this.name             = opts.name             ?? "circuit";
    this.isFailure        = opts.isFailure        ?? (() => true);
  }

  /**
   * Wrap any async call with circuit-breaker protection.
   * Throws `CircuitOpenError` (fast) when the breaker is OPEN.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeReset();

    if (this.state === "OPEN") {
      throw new CircuitOpenError(
        `[CircuitBreaker:${this.name}] OPEN — failing fast. ` +
        `Retry after ${Math.ceil((this.lastOpenAt + this.resetTimeoutMs - Date.now()) / 1000)} s.`
      );
    }

    // CLOSED, or HALF_OPEN letting one probe through (a failed probe re-opens).
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) this.onFailure();
      throw err;
    }
  }

  get currentState(): CircuitState { return this.state; }
  get failures(): number { return this.failureCount; }

  // ── private helpers ──────────────────────────────────────────────────────

  private maybeReset(): void {
    const now = Date.now();
    // Failure window expired → clear counter while still CLOSED.
    if (this.state === "CLOSED" && now - this.lastFailureAt > this.windowMs) {
      this.failureCount = 0;
    }
    // Probe timeout expired → move from OPEN to HALF_OPEN.
    if (this.state === "OPEN" && now - this.lastOpenAt > this.resetTimeoutMs) {
      this.state = "HALF_OPEN";
      console.warn(`[CircuitBreaker:${this.name}] HALF_OPEN — probing.`);
    }
  }

  private onSuccess(): void {
    if (this.state !== "CLOSED") {
      console.log(`[CircuitBreaker:${this.name}] CLOSED — service recovered.`);
    }
    this.state = "CLOSED";
    this.failureCount = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();

    if (this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      this.lastOpenAt = Date.now();
      console.error(
        `[CircuitBreaker:${this.name}] OPEN after ${this.failureCount} failure(s). ` +
        `Will retry in ${this.resetTimeoutMs / 1000} s.`
      );
    }
  }
}

export class CircuitOpenError extends Error {
  readonly code = "circuit_open";
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

// ── Singleton breakers (one per external service) ────────────────────────────

/**
 * Breaker for AssemblyAI token-mint HTTP calls.
 * 3 failures in 30 s trips it; resets after 20 s.
 */
export const assemblyAiBreaker = new CircuitBreaker({
  name: "assemblyai-token",
  failureThreshold: 3,
  windowMs: 30_000,
  resetTimeoutMs: 20_000,
});

