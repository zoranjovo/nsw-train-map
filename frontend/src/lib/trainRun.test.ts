import { describe, expect, it } from "vitest";
import { describeTrainRun } from "./trainRun";

describe("describeTrainRun", () => {
  it("splits a Sydney Trains trip name into its run and trip", () => {
    expect(describeTrainRun("604K.2013.105.2.T.8.91898975")).toEqual({
      kind: "run",
      run: "604",
      trip: "K",
    });
  });

  it("handles trip names with a dash before the trip letter", () => {
    expect(describeTrainRun("93-F.2013.105.128.A.8.92230676")).toEqual({
      kind: "run",
      run: "93",
      trip: "F",
    });
  });

  it("keeps other trip names whole", () => {
    expect(describeTrainRun("N655.2013.105.128.D.10.91899780")).toEqual({
      kind: "train",
      name: "N655",
    });
    expect(describeTrainRun("6BW7.2013.105.128.W.0.91900001")).toEqual({
      kind: "train",
      name: "6BW7",
    });
  });

  it("has nothing to show for trip IDs in another format", () => {
    expect(describeTrainRun("a")).toBeNull();
    expect(describeTrainRun("")).toBeNull();
  });
});
