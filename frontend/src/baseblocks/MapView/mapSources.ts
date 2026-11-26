import type { GeoJSONSource, Map as MaplibreMap } from "maplibre-gl";

export const TFNSW_ATTRIBUTION =
  'Train data &copy; <a href="https://opendata.transport.nsw.gov.au/">Transport for NSW</a>, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';

export const EMPTY_GEOJSON: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const getGeoJSONSource = (map: MaplibreMap, sourceId: string): GeoJSONSource | undefined =>
  map.getSource(sourceId) as GeoJSONSource | undefined;
