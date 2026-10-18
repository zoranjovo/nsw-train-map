import { describe, expect, it } from "vitest";
import type { TrainTrackCoordinate } from "../../types/train/tracks";
import { createRailIndex, type Rail, simplify, snapLineToRails } from "./snapToRails";

const LAT = -33.8;
const METRES_PER_DEGREE_LAT = 110_574;
const METRES_PER_DEGREE_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

// Builds coordinates from metres east/north of a point near Sydney
const at = (east: number, north: number): TrainTrackCoordinate => [
  151 + east / METRES_PER_DEGREE_LON,
  LAT + north / METRES_PER_DEGREE_LAT,
];
const northOf = ([, latitude]: TrainTrackCoordinate) => (latitude - LAT) * METRES_PER_DEGREE_LAT;
const eastOf = ([longitude]: TrainTrackCoordinate) => (longitude - 151) * METRES_PER_DEGREE_LON;

const straightRail = (north: number, usage: Rail["usage"] = "main"): Rail => ({
  usage,
  coordinates: [at(0, north), at(500, north), at(1000, north)],
});

const middleNorths = (coordinates: TrainTrackCoordinate[]) =>
  coordinates.filter((point) => eastOf(point) > 100 && eastOf(point) < 900).map(northOf);

describe("snapLineToRails", () => {
  const doubleTrack = createRailIndex([straightRail(0), straightRail(4)]);

  it("keeps eastbound trains on the left-hand (northern) track", () => {
    const { coordinates } = snapLineToRails([at(0, 1.5), at(1000, 1.5)], doubleTrack);

    for (const north of middleNorths(coordinates)) expect(north).toBeCloseTo(4, 1);
  });

  it("keeps westbound trains on the other track", () => {
    const { coordinates } = snapLineToRails([at(1000, 1.5), at(0, 1.5)], doubleTrack);

    for (const north of middleNorths(coordinates)) expect(north).toBeCloseTo(0, 1);
  });

  it("picks the left track even when the timetable line is well off to one side", () => {
    const { coordinates } = snapLineToRails([at(1000, -12), at(0, -12)], doubleTrack);

    for (const north of middleNorths(coordinates)) expect(north).toBeCloseTo(0, 1);
  });

  it("shares a single track between both directions", () => {
    const singleTrack = createRailIndex([straightRail(0)]);
    const east = snapLineToRails([at(0, 3), at(1000, 3)], singleTrack).coordinates;
    const west = snapLineToRails([at(1000, 3), at(0, 3)], singleTrack).coordinates;

    for (const north of [...middleNorths(east), ...middleNorths(west)]) {
      expect(north).toBeCloseTo(0, 1);
    }
  });

  it("prefers passenger lines over industrial track", () => {
    const index = createRailIndex([straightRail(0), straightRail(6, "industrial")]);
    const { coordinates } = snapLineToRails([at(0, 5), at(1000, 5)], index);

    for (const north of middleNorths(coordinates)) expect(north).toBeCloseTo(0, 1);
  });

  it("follows the rails round a curve the timetable line cuts across", () => {
    const arc: TrainTrackCoordinate[] = [];
    for (let degrees = 0; degrees <= 90; degrees += 3) {
      const radians = (degrees * Math.PI) / 180;
      arc.push(at(400 * Math.sin(radians), 400 - 400 * Math.cos(radians)));
    }
    const curve: Rail = {
      usage: "main",
      coordinates: [at(-500, 0), ...arc, at(400, 900)],
    };
    const index = createRailIndex([curve]);

    const { coordinates, snappedShare } = snapLineToRails(
      [at(-500, 0), at(0, 0), at(400, 400), at(400, 900)],
      index
    );

    expect(snappedShare).toBeGreaterThan(0.95);
    const offCurve = coordinates.map((point) => {
      const dx = eastOf(point);
      const dy = northOf(point) - 400;
      return dx > 0 && dy < 0 ? Math.abs(Math.hypot(dx, dy) - 400) : 0;
    });
    expect(Math.max(...offCurve)).toBeLessThan(1);
  });

  it("stays on one track through a yard instead of hopping as the line wanders", () => {
    const yard = createRailIndex([0, 4, 8, 12].map((north) => straightRail(north)));
    const wandering: TrainTrackCoordinate[] = [];
    for (let east = 0; east <= 1000; east += 50) {
      wandering.push(at(east, 6 + 5 * Math.sin(east / 120)));
    }

    const { coordinates } = snapLineToRails(wandering, yard);

    const tracksUsed = new Set(coordinates.map((point) => Math.round(northOf(point))));
    expect(tracksUsed.size).toBe(1);
  });

  it("leaves lines away from any rails unchanged", () => {
    const line = [at(50_000, 50_000), at(60_000, 50_000)];

    expect(snapLineToRails(line, doubleTrack)).toEqual({ coordinates: line, snappedShare: 0 });
  });
});

describe("simplify", () => {
  it("drops points that sit on a straight line", () => {
    const points = [0, 1, 2, 3, 4].map((x) => ({ x, y: 0 }));

    expect(simplify(points, 0.1)).toEqual([points[0], points[4]]);
  });

  it("keeps corners", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ];

    expect(simplify(points, 0.1)).toEqual(points);
  });
});
