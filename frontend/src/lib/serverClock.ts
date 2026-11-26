let offsetMs = 0;

export const syncServerClock = (serverTimeMs: number): void => {
  offsetMs = serverTimeMs - Date.now();
};

export const serverNowMs = (): number => Date.now() + offsetMs;
