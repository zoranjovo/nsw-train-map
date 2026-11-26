import { useCallback, useEffect, useRef, useState } from "react";

export type UserLocationStatus = "idle" | "locating" | "active" | "denied" | "unavailable";

const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 10_000 };

const hasGeolocation = () => typeof navigator !== "undefined" && "geolocation" in navigator;

export const useUserLocation = () => {
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [status, setStatus] = useState<UserLocationStatus>(() =>
    hasGeolocation() ? "idle" : "unavailable"
  );
  const watchIdRef = useRef<number | null>(null);
  const hasPositionRef = useRef(false);

  const stopWatching = useCallback(() => {
    if (watchIdRef.current === null) return;
    navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
  }, []);

  const clearPosition = useCallback(() => {
    hasPositionRef.current = false;
    setPosition(null);
  }, []);

  const startWatching = useCallback(() => {
    if (!hasGeolocation() || watchIdRef.current !== null) return;
    if (!hasPositionRef.current) setStatus("locating");
    watchIdRef.current = navigator.geolocation.watchPosition(
      (next) => {
        hasPositionRef.current = true;
        setPosition(next);
        setStatus("active");
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          stopWatching();
          clearPosition();
          setStatus("denied");
        } else if (!hasPositionRef.current) {
          stopWatching();
          setStatus("idle");
        }
      },
      WATCH_OPTIONS
    );
  }, [stopWatching, clearPosition]);

  useEffect(() => {
    if (!hasGeolocation() || !navigator.permissions?.query) return stopWatching;

    let permission: PermissionStatus | null = null;
    let cancelled = false;

    const syncPermission = () => {
      if (!permission) return;
      if (permission.state === "granted") {
        startWatching();
      } else if (permission.state === "denied") {
        stopWatching();
        clearPosition();
        setStatus("denied");
      } else {
        setStatus((current) => (current === "denied" ? "idle" : current));
      }
    };

    navigator.permissions
      .query({ name: "geolocation" })
      .then((result) => {
        if (cancelled) return;
        permission = result;
        syncPermission();
        result.addEventListener("change", syncPermission);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      permission?.removeEventListener("change", syncPermission);
      stopWatching();
    };
  }, [startWatching, stopWatching, clearPosition]);

  return { position, status, requestLocation: startWatching };
};
