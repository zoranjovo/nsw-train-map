import type { TrainTrackCoordinate } from "../../types/train/tracks";

export type RailUsage = "main" | "branch" | "industrial" | "other";

export type Rail = {
  usage: RailUsage;
  coordinates: TrainTrackCoordinate[];
  // Crossovers link parallel tracks for routing but trains never snap onto them
  connectorOnly?: boolean;
};

export const SNAP_SETTINGS = {
  sampleSpacingM: 5,
  headingWindowM: 20,
  searchRadiusM: 35,
  // Parallel tracks within this much of the nearest one count as the same corridor
  corridorWidthM: 5,
  minAlignment: Math.cos((35 * Math.PI) / 180),
  // How much longer than the timetable line a route along the rails may be when bridging a gap
  maxDetourRatio: 1.5,
  maxDetourExtraM: 300,
  otherTrackPenaltyM: 30,
  // Map matching costs, per sample: each metre off the timetable line, each corridor track
  // further right than the leftmost, and hopping to a track the rails don't connect to
  offLineWeight: 0.2,
  rightTrackPenaltyM: 5,
  disconnectedHopM: 200,
  maxCandidatesPerSample: 8,
  simplifyToleranceM: 0.4,
  gridCellM: 50,
};

const USAGE_TIER: Record<RailUsage, number> = { main: 0, branch: 0, industrial: 1, other: 1 };

const ORIGIN_LAT = -33.8;
const METRES_PER_DEGREE_LAT = 110_574;
const METRES_PER_DEGREE_LON = 111_320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);

const toX = (longitude: number) => longitude * METRES_PER_DEGREE_LON;
const toY = (latitude: number) => latitude * METRES_PER_DEGREE_LAT;
const toCoordinate = (x: number, y: number): TrainTrackCoordinate => [
  Number((x / METRES_PER_DEGREE_LON).toFixed(7)),
  Number((y / METRES_PER_DEGREE_LAT).toFixed(7)),
];

type Point = { x: number; y: number };

export type RailIndex = {
  vertices: Point[];
  edges: number[][];
  segmentFrom: Uint32Array;
  segmentTo: Uint32Array;
  segmentTier: Uint8Array;
  cells: Map<string, number[]>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

const cellKey = (cx: number, cy: number) => `${cx},${cy}`;

// Rails that meet share a node, so identical coordinates join them into one network
export const createRailIndex = (rails: Rail[]): RailIndex => {
  const vertices: Point[] = [];
  const edges: number[][] = [];
  const vertexByCoordinate = new Map<string, number>();
  const vertexAt = ([longitude, latitude]: TrainTrackCoordinate): number => {
    const key = `${longitude},${latitude}`;
    let vertex = vertexByCoordinate.get(key);
    if (vertex === undefined) {
      vertex = vertices.length;
      vertices.push({ x: toX(longitude), y: toY(latitude) });
      edges.push([]);
      vertexByCoordinate.set(key, vertex);
    }
    return vertex;
  };

  const from: number[] = [];
  const to: number[] = [];
  const tiers: number[] = [];
  for (const rail of rails) {
    for (let i = 1; i < rail.coordinates.length; i++) {
      const a = vertexAt(rail.coordinates[i - 1]);
      const b = vertexAt(rail.coordinates[i]);
      if (a === b) continue;
      edges[a].push(b);
      edges[b].push(a);
      if (rail.connectorOnly) continue;
      from.push(a);
      to.push(b);
      tiers.push(USAGE_TIER[rail.usage]);
    }
  }

  const cells = new Map<string, number[]>();
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const { gridCellM } = SNAP_SETTINGS;
  for (let segment = 0; segment < from.length; segment++) {
    const a = vertices[from[segment]];
    const b = vertices[to[segment]];
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    bounds.minX = Math.min(bounds.minX, minX);
    bounds.minY = Math.min(bounds.minY, minY);
    bounds.maxX = Math.max(bounds.maxX, maxX);
    bounds.maxY = Math.max(bounds.maxY, maxY);
    for (let cx = Math.floor(minX / gridCellM); cx <= Math.floor(maxX / gridCellM); cx++) {
      for (let cy = Math.floor(minY / gridCellM); cy <= Math.floor(maxY / gridCellM); cy++) {
        const key = cellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(segment);
        else cells.set(key, [segment]);
      }
    }
  }

  return {
    vertices,
    edges,
    segmentFrom: Uint32Array.from(from),
    segmentTo: Uint32Array.from(to),
    segmentTier: Uint8Array.from(tiers),
    cells,
    bounds,
  };
};

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

const isNearIndex = (index: RailIndex, a: Point, b: Point): boolean => {
  const margin = SNAP_SETTINGS.searchRadiusM;
  const { minX, minY, maxX, maxY } = index.bounds;
  return (
    Math.max(a.x, b.x) >= minX - margin &&
    Math.min(a.x, b.x) <= maxX + margin &&
    Math.max(a.y, b.y) >= minY - margin &&
    Math.min(a.y, b.y) <= maxY + margin
  );
};

type Sample = { point: Point; snappable: boolean };

// Evenly spaced points along the parts of the line near the rails, the original points elsewhere
const resample = (points: Point[], index: RailIndex): Sample[] => {
  const { sampleSpacingM } = SNAP_SETTINGS;
  const samples: Sample[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!isNearIndex(index, a, b)) {
      samples.push({ point: a, snappable: false });
      continue;
    }
    const steps = Math.max(1, Math.ceil(distance(a, b) / sampleSpacingM));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      samples.push({
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        snappable: true,
      });
    }
  }
  const last = points[points.length - 1];
  samples.push({ point: last, snappable: samples[samples.length - 1]?.snappable ?? false });
  return samples;
};

const headingAt = (samples: Sample[], i: number): Point => {
  const { headingWindowM, sampleSpacingM } = SNAP_SETTINGS;
  const reach = Math.max(1, Math.round(headingWindowM / 2 / sampleSpacingM));
  const from = samples[Math.max(0, i - reach)].point;
  const to = samples[Math.min(samples.length - 1, i + reach)].point;
  const length = distance(from, to);
  return length === 0
    ? { x: 0, y: 0 }
    : { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
};

type Snap = { x: number; y: number; segment: number };
type Candidate = Snap & { distance: number; lateral: number; tier: number };

const candidatesNear = (
  index: RailIndex,
  p: Point,
  heading: Point,
  searchRadiusM = SNAP_SETTINGS.searchRadiusM
): Candidate[] => {
  const { gridCellM, minAlignment } = SNAP_SETTINGS;
  const left = { x: -heading.y, y: heading.x };
  const cx = Math.floor(p.x / gridCellM);
  const cy = Math.floor(p.y / gridCellM);
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const segment of index.cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (seen.has(segment)) continue;
        seen.add(segment);
        const a = index.vertices[index.segmentFrom[segment]];
        const b = index.vertices[index.segmentTo[segment]];
        const sx = b.x - a.x;
        const sy = b.y - a.y;
        const lengthSq = sx * sx + sy * sy;
        const alignment = Math.abs(sx * heading.x + sy * heading.y) / Math.sqrt(lengthSq);
        if (alignment < minAlignment) continue;
        const t = Math.min(1, Math.max(0, ((p.x - a.x) * sx + (p.y - a.y) * sy) / lengthSq));
        const x = a.x + sx * t;
        const y = a.y + sy * t;
        const offset = Math.hypot(x - p.x, y - p.y);
        if (offset > searchRadiusM) continue;
        candidates.push({
          x,
          y,
          segment,
          distance: offset,
          lateral: (x - p.x) * left.x + (y - p.y) * left.y,
          tier: index.segmentTier[segment],
        });
      }
    }
  }
  return candidates;
};

const bestTierOnly = (candidates: Candidate[]): Candidate[] => {
  if (candidates.length === 0) return [];
  const bestTier = Math.min(...candidates.map((candidate) => candidate.tier));
  return candidates.filter((candidate) => candidate.tier === bestTier);
};

// NSW trains keep left, so the corridor's tracks are ranked from the leftmost
const corridorTracks = (candidates: Candidate[]): Candidate[] => {
  const sameTier = bestTierOnly(candidates);
  if (sameTier.length === 0) return [];
  const nearest = Math.min(...sameTier.map((candidate) => candidate.distance));
  return sameTier
    .filter((candidate) => candidate.distance <= nearest + SNAP_SETTINGS.corridorWidthM)
    .sort((a, b) => b.lateral - a.lateral);
};

type Scored = { snap: Candidate; cost: number };

const scoreCandidates = (candidates: Candidate[]): Scored[] => {
  const sameTier = bestTierOnly(candidates);
  const corridor = corridorTracks(sameTier);
  const { offLineWeight, rightTrackPenaltyM, maxCandidatesPerSample } = SNAP_SETTINGS;
  return sameTier
    .map((snap) => {
      const rank = corridor.indexOf(snap);
      const tracksToTheLeft = Math.max(0, rank);
      return { snap, cost: snap.distance * offLineWeight + tracksToTheLeft * rightTrackPenaltyM };
    })
    .sort((a, b) => a.cost - b.cost)
    .slice(0, maxCandidatesPerSample);
};

type Search = { cost: Map<number, number>; previous: Map<number, number> };

const searchRails = (
  index: RailIndex,
  sources: { vertex: number; cost: number }[],
  limit: number,
  stopAt: (vertex: number, cost: number) => boolean = () => false
): Search => {
  const { vertices, edges } = index;
  const cost = new Map<number, number>();
  const previous = new Map<number, number>();
  const queue: [number, number][] = [];
  const push = (vertex: number, value: number, from: number) => {
    if (value > limit || value >= (cost.get(vertex) ?? Infinity)) return;
    cost.set(vertex, value);
    previous.set(vertex, from);
    queue.push([value, vertex]);
    let i = queue.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (queue[parent][0] <= queue[i][0]) break;
      [queue[parent], queue[i]] = [queue[i], queue[parent]];
      i = parent;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = queue[0];
    const last = queue.pop();
    if (queue.length > 0 && last) {
      queue[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < queue.length && queue[l][0] < queue[smallest][0]) smallest = l;
        if (r < queue.length && queue[r][0] < queue[smallest][0]) smallest = r;
        if (smallest === i) break;
        [queue[smallest], queue[i]] = [queue[i], queue[smallest]];
        i = smallest;
      }
    }
    return top;
  };

  for (const source of sources) push(source.vertex, source.cost, -1);
  for (let item = pop(); item; item = pop()) {
    const [value, vertex] = item;
    if (value > (cost.get(vertex) ?? Infinity)) continue;
    if (stopAt(vertex, value)) break;
    for (const next of edges[vertex]) {
      push(next, value + distance(vertices[vertex], vertices[next]), vertex);
    }
  }
  return { cost, previous };
};

const segmentEnds = (index: RailIndex, segment: number) => [
  index.segmentFrom[segment],
  index.segmentTo[segment],
];

type Route = { path: Point[]; start: Snap; end: Snap };

// Shortest way along the rails between the tracks either side of a gap, favouring the keep-left
// track at each end, or null if every way round is much longer than the gap
const routeAlongRails = (
  index: RailIndex,
  starts: Snap[],
  ends: Snap[],
  expectedLength: number
): Route | null => {
  const { vertices } = index;
  const limit = expectedLength * SNAP_SETTINGS.maxDetourRatio + SNAP_SETTINGS.maxDetourExtraM;
  const sources: { vertex: number; cost: number; start: Snap }[] = [];
  starts.forEach((start, rank) => {
    for (const vertex of segmentEnds(index, start.segment)) {
      const cost = rank * SNAP_SETTINGS.otherTrackPenaltyM + distance(start, vertices[vertex]);
      sources.push({ vertex, cost, start });
    }
  });
  const targets = new Map<number, { cost: number; end: Snap }>();
  ends.forEach((end, rank) => {
    for (const vertex of segmentEnds(index, end.segment)) {
      const cost = rank * SNAP_SETTINGS.otherTrackPenaltyM + distance(end, vertices[vertex]);
      if (cost < (targets.get(vertex)?.cost ?? Infinity)) targets.set(vertex, { cost, end });
    }
  });

  let reached = -1;
  let reachedCost = Infinity;
  const { previous } = searchRails(index, sources, limit, (vertex, cost) => {
    if (cost >= reachedCost) return true;
    const target = targets.get(vertex);
    if (target !== undefined && cost + target.cost < reachedCost) {
      reached = vertex;
      reachedCost = cost + target.cost;
    }
    return false;
  });
  const end = targets.get(reached)?.end;
  if (reached === -1 || !end || reachedCost > limit) return null;

  const route: number[] = [];
  for (let vertex = reached; vertex !== -1; vertex = previous.get(vertex) ?? -1) {
    route.push(vertex);
  }
  route.reverse();
  const start = sources
    .filter((source) => source.vertex === route[0])
    .sort((a, b) => a.cost - b.cost)[0]?.start;
  if (!start) return null;
  return { path: route.map((vertex) => vertices[vertex]), start, end };
};

const NEARBY_LIMIT_M = 40;
const nearbyCaches = new WeakMap<RailIndex, Map<number, Map<number, number>>>();

// Rail distances from a node to every node within a short ride of it, worked out once per node
const nearbyVertices = (index: RailIndex, vertex: number): Map<number, number> => {
  let cache = nearbyCaches.get(index);
  if (!cache) {
    cache = new Map();
    nearbyCaches.set(index, cache);
  }
  let nearby = cache.get(vertex);
  if (!nearby) {
    nearby = searchRails(index, [{ vertex, cost: 0 }], NEARBY_LIMIT_M).cost;
    cache.set(vertex, nearby);
  }
  return nearby;
};

// Distance along the rails from one snapped point to another, if it's a short ride
const railDistance = (index: RailIndex, from: Snap, to: Snap): number | null => {
  if (from.segment === to.segment) return distance(from, to);
  const { vertices } = index;
  let best: number | null = null;
  for (const start of segmentEnds(index, from.segment)) {
    const nearby = nearbyVertices(index, start);
    for (const end of segmentEnds(index, to.segment)) {
      const between = nearby.get(end);
      if (between === undefined) continue;
      const total = distance(from, vertices[start]) + between + distance(vertices[end], to);
      if (best === null || total < best) best = total;
    }
  }
  return best;
};

// Picks one track per sample so the whole run stays on connected rails, keeping left where it can
const matchRun = (index: RailIndex, steps: number[], scored: Scored[][]): Snap[] => {
  const { disconnectedHopM } = SNAP_SETTINGS;
  const costs: number[][] = [scored[0].map((option) => option.cost)];
  const back: number[][] = [scored[0].map(() => -1)];
  for (let i = 1; i < scored.length; i++) {
    const step = steps[i];
    const row = scored[i].map(() => Infinity);
    const from = scored[i].map(() => -1);
    scored[i - 1].forEach((previous, p) => {
      scored[i].forEach((option, k) => {
        const along = railDistance(index, previous.snap, option.snap);
        const move =
          along === null
            ? disconnectedHopM + distance(previous.snap, option.snap)
            : Math.abs(along - step);
        const total = costs[i - 1][p] + move + option.cost;
        if (total < row[k]) {
          row[k] = total;
          from[k] = p;
        }
      });
    });
    costs.push(row);
    back.push(from);
  }

  const picked: Snap[] = new Array(scored.length);
  const lastCosts = costs[costs.length - 1];
  let k = lastCosts.indexOf(Math.min(...lastCosts));
  for (let i = scored.length - 1; i >= 0; i--) {
    picked[i] = scored[i][k].snap;
    k = back[i][k];
  }
  return picked;
};

const perpendicularDistance = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};

export const simplify = (points: Point[], tolerance: number): Point[] => {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let farthest = -1;
    let farthestDistance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const offset = perpendicularDistance(points[i], points[start], points[end]);
      if (offset > farthestDistance) {
        farthest = i;
        farthestDistance = offset;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
};

const matchSamples = (samples: Sample[], index: RailIndex): (Snap | null)[] => {
  const scored = samples.map(({ point, snappable }, i) =>
    snappable ? scoreCandidates(candidatesNear(index, point, headingAt(samples, i))) : []
  );
  const snaps: (Snap | null)[] = samples.map(() => null);
  let runStart = 0;
  while (runStart < samples.length) {
    if (scored[runStart].length === 0) {
      runStart++;
      continue;
    }
    let runEnd = runStart;
    while (runEnd < samples.length && scored[runEnd].length > 0) runEnd++;
    const steps: number[] = [];
    for (let k = runStart; k < runEnd; k++) {
      steps.push(k === runStart ? 0 : distance(samples[k - 1].point, samples[k].point));
    }
    matchRun(index, steps, scored.slice(runStart, runEnd)).forEach((snap, offset) => {
      snaps[runStart + offset] = snap;
    });
    runStart = runEnd;
  }
  return snaps;
};

export type SnapResult = {
  coordinates: TrainTrackCoordinate[];
  // Share of the line near the rails that ended up on them
  snappedShare: number;
};

export const snapLineToRails = (
  coordinates: TrainTrackCoordinate[],
  index: RailIndex
): SnapResult => {
  if (coordinates.length < 2) return { coordinates, snappedShare: 0 };
  const points = coordinates.map(([longitude, latitude]) => ({
    x: toX(longitude),
    y: toY(latitude),
  }));
  const samples = resample(points, index);
  if (!samples.some((sample) => sample.snappable)) return { coordinates, snappedShare: 0 };
  const snaps = matchSamples(samples, index);

  const output: Point[] = [];
  let snappableCount = 0;
  let onRailsCount = 0;
  let i = 0;
  while (i < samples.length) {
    const snap = snaps[i];
    if (samples[i].snappable) snappableCount++;
    if (snap) {
      output.push(snap);
      onRailsCount++;
      i++;
      continue;
    }

    let gapEnd = i;
    while (gapEnd < samples.length && !snaps[gapEnd] && samples[gapEnd].snappable) gapEnd++;
    const before = snaps[i - 1];
    const after = snaps[gapEnd];
    if (gapEnd > i && before && after) {
      let expectedLength = 0;
      for (let k = i - 1; k < gapEnd; k++) {
        expectedLength += distance(samples[k].point, samples[k + 1].point);
      }
      // Search a little wider so a corridor at the edge of the snap radius isn't cut in half
      const radius = SNAP_SETTINGS.searchRadiusM + SNAP_SETTINGS.corridorWidthM * 2;
      const tracksAt = (k: number, preferred: Snap) => [
        preferred,
        ...corridorTracks(
          candidatesNear(index, samples[k].point, headingAt(samples, k), radius)
        ).filter((track) => track.segment !== preferred.segment),
      ];
      const route = routeAlongRails(
        index,
        tracksAt(i - 1, before),
        tracksAt(gapEnd, after),
        expectedLength
      );
      if (route) {
        output[output.length - 1] = route.start;
        output.push(...route.path);
        snaps[gapEnd] = route.end;
        snappableCount += gapEnd - i - 1;
        onRailsCount += gapEnd - i;
        i = gapEnd;
        continue;
      }
    }
    const stop = Math.max(gapEnd, i + 1);
    for (let k = i; k < stop; k++) {
      output.push(samples[k].point);
      if (k > i && samples[k].snappable) snappableCount++;
    }
    i = stop;
  }

  return {
    coordinates: simplify(output, SNAP_SETTINGS.simplifyToleranceM).map(({ x, y }) =>
      toCoordinate(x, y)
    ),
    snappedShare: snappableCount === 0 ? 0 : onRailsCount / snappableCount,
  };
};
