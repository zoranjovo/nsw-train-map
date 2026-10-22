import { describe, expect, it } from "vitest";
import { createProgressSmoother, type ProgressInput } from "./trainProgressSmoother";

const FRAME_MS = 100;
const SPEED = 20;
const path = {};

type Scenario = (seconds: number) => Partial<ProgressInput> & { target: number };

// Runs one train through a scenario frame by frame and returns where it was shown each frame
const simulate = (scenario: Scenario, seconds: number, startSeconds = 0) => {
  const smoother = createProgressSmoother();
  const shown: { seconds: number; distance: number; target: number }[] = [];
  for (let ms = startSeconds * 1000; ms <= seconds * 1000; ms += FRAME_MS) {
    const at = ms / 1000;
    const input: ProgressInput = {
      path,
      direction: 1,
      trackLength: 100_000,
      speed: SPEED,
      reported: null,
      ...scenario(at),
    };
    shown.push({
      seconds: at,
      distance: smoother.update("train", input, ms),
      target: input.target,
    });
  }
  return shown;
};

const stepsOf = (shown: { distance: number }[]) =>
  shown.slice(1).map((frame, i) => frame.distance - shown[i].distance);

describe("createProgressSmoother", () => {
  it("follows the timetable exactly when nothing changes", () => {
    const shown = simulate((t) => ({ target: 1000 + SPEED * t }), 60);

    for (const frame of shown) expect(frame.distance).toBeCloseTo(frame.target, 6);
  });

  it("slows down instead of going backwards when the train gets later", () => {
    const shown = simulate((t) => ({ target: 1000 + SPEED * t - (t >= 10 ? 1200 : 0) }), 240);

    expect(Math.min(...stepsOf(shown))).toBeGreaterThan(0);
    const settled = shown.filter((frame) => frame.seconds >= 200);
    for (const frame of settled) expect(Math.abs(frame.distance - frame.target)).toBeLessThan(5);
  });

  it("speeds up to catch up when the train gets earlier, without jumping", () => {
    const shown = simulate((t) => ({ target: 1000 + SPEED * t + (t >= 10 ? 600 : 0) }), 240);

    const fastest = Math.max(SPEED * 1.6, SPEED + 10) * (FRAME_MS / 1000);
    expect(Math.max(...stepsOf(shown))).toBeLessThanOrEqual(fastest + 1e-9);
    const settled = shown.filter((frame) => frame.seconds >= 150);
    for (const frame of settled) expect(Math.abs(frame.distance - frame.target)).toBeLessThan(5);
  });

  it("waits for a train that is stopped at a station but shown past it", () => {
    const shown = simulate((t) => ({ target: t < 5 ? 1000 : 900, speed: 0 }), 30);

    expect(Math.min(...stepsOf(shown))).toBeGreaterThanOrEqual(0);
    expect(shown[shown.length - 1].distance).toBeCloseTo(1000, 6);
  });

  it("jumps straight to the new position after a very large correction", () => {
    const shown = simulate((t) => ({ target: t < 5 ? 1000 : 10_000, speed: 0 }), 6);

    expect(shown[shown.length - 1].distance).toBe(10_000);
  });

  it("jumps straight to the new position when the train moves to a different track line", () => {
    const other = {};
    const shown = simulate(
      (t) => (t < 5 ? { target: 1000, speed: 0 } : { target: 1500, speed: 0, path: other }),
      6
    );

    expect(shown[shown.length - 1].distance).toBe(1500);
  });

  it("keeps the train near its last GPS report when the timetable disagrees", () => {
    const shown = simulate(
      (t) => ({
        target: 3000 + SPEED * t,
        reported: { distance: 1000 + SPEED * t, ageSeconds: 0 },
      }),
      30
    );

    for (const frame of shown) {
      expect(frame.distance - (1000 + SPEED * frame.seconds)).toBeLessThanOrEqual(400 + 1e-9);
    }
  });

  it("allows for how old the GPS report is", () => {
    const [first] = simulate(
      () => ({ target: 5000, reported: { distance: 1000, ageSeconds: 20 } }),
      0
    );

    expect(first.distance).toBe(1000 + SPEED * 20 + 400);
  });

  it("ignores GPS reports that are too old to trust", () => {
    const [first] = simulate(
      () => ({ target: 5000, reported: { distance: 1000, ageSeconds: 600 } }),
      0
    );

    expect(first.distance).toBe(5000);
  });

  it("works the same for trains running down the track", () => {
    const shown = simulate(
      (t) => ({ direction: -1, target: 50_000 - SPEED * t + (t >= 10 ? 1200 : 0) }),
      240
    );

    expect(Math.max(...stepsOf(shown))).toBeLessThan(0);
    const settled = shown.filter((frame) => frame.seconds >= 200);
    for (const frame of settled) expect(Math.abs(frame.distance - frame.target)).toBeLessThan(5);
  });
});
