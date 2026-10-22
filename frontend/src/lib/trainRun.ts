export type TrainRun = { kind: "run"; run: string; trip: string } | { kind: "train"; name: string };

// Trip IDs start with the trip name, e.g. "604K.2013.105.2.T.8.91898975". On Sydney Trains the
// digits are the run and the letter is which trip of the run it is; other services just get a name
export const describeTrainRun = (tripId: string): TrainRun | null => {
  const parts = tripId.split(".");
  if (parts.length !== 7 || !parts[0]) return null;
  const name = parts[0];
  const match = name.match(/^(\d+)-?([A-Z])$/);
  return match ? { kind: "run", run: match[1], trip: match[2] } : { kind: "train", name };
};
