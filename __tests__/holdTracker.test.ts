import { QuickPoseHoldTracker } from '../src/lib/holdTracker';

/**
 * The hold algorithm is the one piece of the plank/wall-sit work that does not
 * need a camera, a device, or a QuickPose key to verify — it is pure arithmetic
 * over an injected clock. Everything else in that path (whether the pose model
 * actually scores a plank or a wall-braced squat highly) can only be confirmed
 * on a real device.
 */
describe('QuickPoseHoldTracker', () => {
  it('accumulates a single unbroken hold', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.9, 1000); // enters
    expect(t.snapshot(6000).totalHeldMs).toBe(5000);
    expect(t.snapshot(6000).isHolding).toBe(true);
  });

  it('banks a segment when the pose drops below the exit threshold', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.9, 0);
    t.update(0.1, 4000); // breaks
    const snap = t.snapshot(9000);
    expect(snap.isHolding).toBe(false);
    expect(snap.totalHeldMs).toBe(4000); // does not keep counting after a break
    expect(snap.segmentsMs).toEqual([4000]);
  });

  it('sums multiple segments across breaks', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.9, 0);
    t.update(0.1, 3000); // 3s
    t.update(0.9, 5000);
    t.update(0.1, 9000); // 4s
    expect(t.snapshot(9000).totalHeldMs).toBe(7000);
    expect(t.snapshot(9000).segmentsMs).toEqual([3000, 4000]);
  });

  it('holds through hysteresis: mid-band noise neither enters nor breaks', () => {
    const t = new QuickPoseHoldTracker(); // enter 0.6, exit 0.3
    t.update(0.9, 0);
    t.update(0.45, 1000); // between thresholds -> still holding
    t.update(0.35, 2000); // still above exit -> still holding
    expect(t.snapshot(3000).isHolding).toBe(true);
    expect(t.snapshot(3000).totalHeldMs).toBe(3000);
    expect(t.snapshot(3000).segmentsMs).toEqual([]);
  });

  it('does not enter on a value between the two thresholds', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.45, 0); // above exit but below enter -> must not start
    expect(t.snapshot(5000).isHolding).toBe(false);
    expect(t.snapshot(5000).totalHeldMs).toBe(0);
  });

  it('finish() banks an in-progress segment (the whole-hold regression)', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.9, 0);
    const snap = t.finish(12000);
    expect(snap.isHolding).toBe(false);
    expect(snap.totalHeldMs).toBe(12000);
    expect(snap.segmentsMs).toEqual([12000]);
  });

  it('finish() is a no-op when not holding', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.9, 0);
    t.update(0.1, 2000);
    const snap = t.finish(8000);
    expect(snap.totalHeldMs).toBe(2000);
    expect(snap.segmentsMs).toEqual([2000]);
  });

  it('reset() clears banked time', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.9, 0);
    t.finish(5000);
    t.reset();
    expect(t.snapshot(9000).totalHeldMs).toBe(0);
    expect(t.snapshot(9000).segmentsMs).toEqual([]);
  });

  it('never subtracts from the total if the clock goes backwards', () => {
    const t = new QuickPoseHoldTracker();
    t.update(0.9, 5000);
    const snap = t.finish(4000); // earlier than the start
    expect(snap.totalHeldMs).toBe(0);
  });
});
