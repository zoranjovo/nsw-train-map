export const PROGRESS_SMOOTHING = {
  // A gap between the shown and expected position closes over roughly this long, and never
  // slower than minClosingSpeed so the last few metres don't drag on
  catchUpSeconds: 20,
  minClosingSpeed: 1,
  // Catching up never goes faster than the larger of these over the timetable speed
  maxSpeedRatio: 1.6,
  maxExtraSpeed: 10,
  // Running ahead slows the train to this share of its timetable speed, never backwards
  minSpeedRatio: 0.35,
  // Bigger corrections than this jump straight to the new position
  snapDistanceM: 3000,
  // The train is never shown further than this from where its last GPS report puts it
  reportedLeewayM: 400,
  maxReportedAgeSeconds: 90,
  maxReportedExtrapolationSeconds: 30,
  // A train not drawn for this long has nothing on screen to smooth from
  maxFrameGapMs: 5000,
};

export type ProgressInput = {
  path: object;
  direction: number;
  trackLength: number;
  // Where and how fast the timetable has the train right now
  target: number;
  speed: number;
  reported: { distance: number; ageSeconds: number } | null;
};

type State = { path: object; direction: number; distance: number; atMs: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Where the last GPS report says the train should be by now, if it's recent enough to trust
const expectedFromReported = ({ speed, direction, reported }: ProgressInput): number | null => {
  const { maxReportedAgeSeconds, maxReportedExtrapolationSeconds } = PROGRESS_SMOOTHING;
  if (!reported || reported.ageSeconds > maxReportedAgeSeconds) return null;
  const travelled = speed * clamp(reported.ageSeconds, 0, maxReportedExtrapolationSeconds);
  return reported.distance + direction * travelled;
};

export type ProgressSmoother = {
  update: (key: string, input: ProgressInput, nowMs: number) => number;
  retainOnly: (keys: Set<string>) => void;
};

// Eases each train towards its timetable position instead of jumping when delays change
export const createProgressSmoother = (): ProgressSmoother => {
  const states = new Map<string, State>();

  const update: ProgressSmoother["update"] = (key, input, nowMs) => {
    const {
      catchUpSeconds,
      maxSpeedRatio,
      maxExtraSpeed,
      minSpeedRatio,
      minClosingSpeed,
      snapDistanceM,
      reportedLeewayM,
      maxFrameGapMs,
    } = PROGRESS_SMOOTHING;
    const expected = expectedFromReported(input);
    const goal =
      expected == null
        ? input.target
        : clamp(input.target, expected - reportedLeewayM, expected + reportedLeewayM);
    const previous = states.get(key);

    let distance = goal;
    if (
      previous &&
      previous.path === input.path &&
      previous.direction === input.direction &&
      nowMs - previous.atMs <= maxFrameGapMs &&
      Math.abs(goal - previous.distance) <= snapDistanceM
    ) {
      const elapsedSeconds = Math.max(0, nowMs - previous.atMs) / 1000;
      const behind = (goal - previous.distance) * input.direction;
      const fastest = Math.max(input.speed * maxSpeedRatio, input.speed + maxExtraSpeed);
      const farAheadOfReported =
        expected != null && (previous.distance - expected) * input.direction > reportedLeewayM;
      const slowest = farAheadOfReported ? 0 : input.speed * minSpeedRatio;
      const gap = Math.abs(behind);
      const closing = Math.max(
        gap / catchUpSeconds,
        Math.min(minClosingSpeed, elapsedSeconds > 0 ? gap / elapsedSeconds : 0)
      );
      const speed = clamp(input.speed + Math.sign(behind) * closing, slowest, fastest);
      let step = speed * elapsedSeconds;
      if (behind > 0) step = Math.min(step, behind);
      distance = previous.distance + step * input.direction;
    }

    distance = clamp(distance, 0, input.trackLength);
    states.set(key, { path: input.path, direction: input.direction, distance, atMs: nowMs });
    return distance;
  };

  return {
    update,
    retainOnly: (keys) => {
      for (const key of states.keys()) {
        if (!keys.has(key)) states.delete(key);
      }
    },
  };
};
