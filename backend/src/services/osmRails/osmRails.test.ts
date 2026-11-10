import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrainTracksResponse } from "../../types/train/tracks";
import { loadOsmRails, refreshOsmRails, snapTracksToOsm } from "./osmRails";

vi.mock("./snapToRails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapToRails")>()),
  snapLineToRails: () => {
    throw new Error("snapping failed");
  },
}));

const assetsDirWithCache = async (content: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "osm-rails-"));
  await writeFile(join(dir, "osm-rails.json"), JSON.stringify(content));
  return dir;
};

const rail = {
  usage: "main",
  coordinates: [
    [151, -33.8],
    [151.01, -33.8],
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("loadOsmRails", () => {
  it("ignores a cached copy with malformed rails", async () => {
    const dir = await assetsDirWithCache([rail, { usage: "main" }]);

    expect(await loadOsmRails(dir)).toBeNull();
  });
});

describe("snapTracksToOsm", () => {
  it("keeps the timetable shapes when snapping fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = await assetsDirWithCache([rail]);
    const tracks = {
      type: "FeatureCollection",
      name: "tracks",
      features: [
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: rail.coordinates },
          properties: {},
        },
      ],
    } as unknown as TrainTracksResponse;

    expect(await snapTracksToOsm(tracks, dir)).toBe(tracks);
  });
});

describe("refreshOsmRails", () => {
  it("gives up without waiting after the last attempt, then backs off", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const post = vi.spyOn(axios, "post").mockRejectedValue(new Error("unavailable"));
    const dir = await mkdtemp(join(tmpdir(), "osm-rails-"));
    const startedAt = Date.now();

    let refreshed: boolean | null = null;
    void refreshOsmRails(dir).then((result) => {
      refreshed = result;
    });
    while (refreshed == null) await vi.advanceTimersByTimeAsync(1000);

    expect(refreshed).toBe(false);
    expect(post).toHaveBeenCalledTimes(6);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(41_000);

    expect(await refreshOsmRails(dir)).toBe(false);
    expect(post).toHaveBeenCalledTimes(6);
  });
});
