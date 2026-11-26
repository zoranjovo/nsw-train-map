import { Navigation } from "lucide-react";
import maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useUserLocation } from "@/hooks/use-user-location";
import { isMapRemoved, useMapLibre } from "./MapContext";
import styles from "./MapView.module.css";

const LOCATE_MIN_ZOOM = 15;

const LABELS = {
  idle: "Show my location",
  locating: "Finding your location…",
  active: "Go to my location",
  denied: "Location access is blocked in your browser settings",
  unavailable: "Location is not available",
} as const;

export const UserLocation = () => {
  const map = useMapLibre();
  const { position, status, requestLocation } = useUserLocation();
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const pendingFlyRef = useRef(false);

  useEffect(() => {
    if (!map || !position) return;
    const lngLat: [number, number] = [position.coords.longitude, position.coords.latitude];

    if (!markerRef.current) {
      const element = document.createElement("div");
      element.className = styles.userDot;
      element.setAttribute("aria-hidden", "true");
      markerRef.current = new maplibregl.Marker({ element }).setLngLat(lngLat).addTo(map);
    } else {
      markerRef.current.setLngLat(lngLat);
    }

    if (pendingFlyRef.current) {
      pendingFlyRef.current = false;
      map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), LOCATE_MIN_ZOOM) });
    }
  }, [map, position]);

  useEffect(() => {
    if (status === "denied" || status === "idle") pendingFlyRef.current = false;
  }, [status]);

  useEffect(() => {
    if (position) return;
    markerRef.current?.remove();
    markerRef.current = null;
  }, [position]);

  useEffect(() => {
    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
    };
  }, []);

  if (!map || status === "unavailable") return null;

  const handleClick = () => {
    if (isMapRemoved(map)) return;
    if (position) {
      map.flyTo({
        center: [position.coords.longitude, position.coords.latitude],
        zoom: Math.max(map.getZoom(), LOCATE_MIN_ZOOM),
      });
      return;
    }
    pendingFlyRef.current = true;
    requestLocation();
  };

  const label = LABELS[status];

  return (
    <button
      type="button"
      className={styles.locateButton}
      data-status={status}
      title={label}
      aria-label={label}
      onClick={handleClick}
    >
      <Navigation size={16} />
    </button>
  );
};
