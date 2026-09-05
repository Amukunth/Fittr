/**
 * Accumulates how long a pose probability stays above threshold — the
 * hold-duration analogue of the SDK's QuickPoseThresholdCounter.
 *
 * WHY THIS EXISTS: QuickPoseThresholdCounter is a *rep* counter. It increments
 * on each enter->exit crossing (see its source: `poseComplete(count + 1)`) and
 * carries no notion of elapsed time, so it cannot express "held for 47
 * seconds". Nothing else in @quickpose/react-native does either.
 *
 * It deliberately mirrors that class's shape — same 0.6/0.3 enter/exit
 * defaults, same "feed it one probability per frame" call style, same reset()
 * — so plank/wall-sit read like the push-up path rather than a second idiom.
 *
 * HYSTERESIS is the same trick and matters for the same reason: a single
 * threshold would let probability noise around the boundary chop one real hold
 * into dozens of fragments. Rising above enterThreshold starts a segment;
 * only falling below the lower exitThreshold ends it.
 *
 * `nowMs` is injected rather than read from Date.now() internally so this is
 * unit-testable without a camera — see __tests__/holdTracker.test.ts, which is
 * the only part of the plank/wall-sit work that can be verified off-device.
 */

export interface HoldSnapshot {
  /** True while the pose is currently above threshold. */
  readonly isHolding: boolean;
  /** Closed segments plus the in-progress one, so this ticks up live. */
  readonly totalHeldMs: number;
  /** Durations of completed segments, oldest first. */
  readonly segmentsMs: readonly number[];
}

export class QuickPoseHoldTracker {
  readonly enterThreshold: number;
  readonly exitThreshold: number;

  private holding = false;
  private segmentStartMs: number | null = null;
  private closedTotalMs = 0;
  private segments: number[] = [];

  constructor(enterThreshold = 0.6, exitThreshold = 0.3) {
    this.enterThreshold = enterThreshold;
    this.exitThreshold = exitThreshold;
  }

  /**
   * Feed one frame's pose probability. `onChange` fires only on an actual
   * hold/break transition, not every frame.
   */
  update(
    value: number,
    nowMs: number,
    onChange?: (snapshot: HoldSnapshot) => void,
  ): HoldSnapshot {
    if (!this.holding && value > this.enterThreshold) {
      this.holding = true;
      this.segmentStartMs = nowMs;
      onChange?.(this.snapshot(nowMs));
    } else if (this.holding && value < this.exitThreshold) {
      this.closeSegment(nowMs);
      onChange?.(this.snapshot(nowMs));
    }
    return this.snapshot(nowMs);
  }

  /**
   * Close an open segment at `nowMs`. MUST be called when the set ends while
   * the user is still in position — otherwise the final (often longest)
   * segment is never banked and the whole hold is under-reported.
   */
  finish(nowMs: number): HoldSnapshot {
    if (this.holding) {
      this.closeSegment(nowMs);
    }
    return this.snapshot(nowMs);
  }

  reset(): void {
    this.holding = false;
    this.segmentStartMs = null;
    this.closedTotalMs = 0;
    this.segments = [];
  }

  snapshot(nowMs: number): HoldSnapshot {
    const openMs =
      this.holding && this.segmentStartMs !== null
        ? Math.max(0, nowMs - this.segmentStartMs)
        : 0;
    return {
      isHolding: this.holding,
      totalHeldMs: this.closedTotalMs + openMs,
      segmentsMs: this.segments,
    };
  }

  private closeSegment(nowMs: number): void {
    const started = this.segmentStartMs;
    this.holding = false;
    this.segmentStartMs = null;
    if (started === null) {
      return;
    }
    // Clamped: a non-monotonic clock must never subtract from a banked total.
    const duration = Math.max(0, nowMs - started);
    this.segments.push(duration);
    this.closedTotalMs += duration;
  }
}
