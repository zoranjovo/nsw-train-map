import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import axios from "axios";
import type { TrainTracksResponse } from "../../types/train/tracks";
import { debugLog } from "../../utils/debug";
import { describeError } from "../../utils/errors";
import { createRailIndex, type Rail, type RailUsage, snapLineToRails } from "./snapToRails";

// Sydney Trains and the intercity lines; regional lines further out keep the timetable's shapes
const OSM_RAIL_AREA = { south: -34.95, west: 149.6, north: -32.6, east: 152.0 };
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const OVERPASS_TIMEOUT_MS = 4 * 60 * 1000;
const OVERPASS_ATTEMPTS = 3;
const OVERPASS_RETRY_DELAY_MS = 20_000;
const CACHE_FILE = "osm-rails.json";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type OverpassWay = {
  type: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
};

const overpassQuery = () => {
  const { south, west, north, east } = OSM_RAIL_AREA;
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:180];(way["railway"="rail"][!"service"](${bbox});way["railway"="rail"]["service"="crossover"](${bbox}););out tags geom;`;
};

const toUsage = (usage: string | undefined): RailUsage =>
  usage === "main" || usage === "branch" || usage === "industrial" ? usage : "other";

export const toRails = (elements: OverpassWay[]): Rail[] =>
  elements.flatMap((element) => {
    if (element.type !== "way" || !element.geometry || element.geometry.length < 2) return [];
    return [
      {
        usage: toUsage(element.tags?.usage),
        coordinates: element.geometry.map(({ lon, lat }) => [lon, lat] as [number, number]),
        ...(element.tags?.service ? { connectorOnly: true } : {}),
      },
    ];
  });

const fetchRails = async (): Promise<Rail[]> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < OVERPASS_ATTEMPTS; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        debugLog("OSM", `fetching rails from ${endpoint}`);
        const response = await axios.post<{ elements: OverpassWay[] }>(
          endpoint,
          new URLSearchParams({ data: overpassQuery() }),
          {
            timeout: OVERPASS_TIMEOUT_MS,
            headers: { "User-Agent": "nsw-train-map (https://github.com/zoranjovo/nsw-train-map)" },
          }
        );
        const rails = toRails(response.data.elements ?? []);
        if (rails.length === 0) throw new Error("Overpass returned no rails");
        return rails;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((done) => setTimeout(done, OVERPASS_RETRY_DELAY_MS));
  }
  throw lastError ?? new Error("Could not fetch OSM rails");
};

const readCache = async (cachePath: string): Promise<{ rails: Rail[]; ageMs: number } | null> => {
  try {
    const [content, info] = await Promise.all([readFile(cachePath, "utf8"), stat(cachePath)]);
    const rails = JSON.parse(content) as Rail[];
    return Array.isArray(rails) && rails.length > 0
      ? { rails, ageMs: Date.now() - info.mtimeMs }
      : null;
  } catch {
    return null;
  }
};

export const loadOsmRails = async (assetsDir: string): Promise<Rail[] | null> => {
  const cachePath = resolve(assetsDir, CACHE_FILE);
  const cached = await readCache(cachePath);
  if (cached && cached.ageMs < CACHE_MAX_AGE_MS) return cached.rails;

  try {
    const rails = await fetchRails();
    await mkdir(assetsDir, { recursive: true });
    await writeFile(`${cachePath}.tmp`, JSON.stringify(rails), "utf8");
    await rename(`${cachePath}.tmp`, cachePath);
    debugLog("OSM", `cached ${rails.length} rails`);
    return rails;
  } catch (error) {
    console.error(
      `Could not fetch OSM rails, ${cached ? "using the old copy" : "keeping timetable track shapes"}: ${describeError(error)}`
    );
    return cached?.rails ?? null;
  }
};

export const snapTracksToOsm = async (
  tracks: TrainTracksResponse,
  assetsDir: string
): Promise<TrainTracksResponse> => {
  const rails = await loadOsmRails(assetsDir);
  if (!rails) return tracks;

  const startedAt = Date.now();
  const index = createRailIndex(rails);
  const features = tracks.features.map((feature) => ({
    ...feature,
    geometry: {
      ...feature.geometry,
      coordinates: snapLineToRails(feature.geometry.coordinates, index).coordinates,
    },
  }));
  debugLog("OSM", `snapped ${features.length} track shapes in ${Date.now() - startedAt} ms`);
  return { ...tracks, features };
};
