const EARTH_RADIUS_M = 6_371_000;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type LocationResult =
  | 'PASSED'
  | 'OUTSIDE_RADIUS'
  | 'POOR_ACCURACY'
  | 'NO_LOCATION'
  | 'CAMPUS_NOT_CONFIGURED';

export interface LocationEvaluation {
  result: LocationResult;
  distanceM: number | null;
  /** True when the point is inside the radius but its accuracy circle reaches outside it. */
  boundary: boolean;
}

export interface CampusGeo {
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  /** Maximum acceptable reported accuracy in metres (campus override or global setting). */
  requiredAccuracyM: number;
}

export interface ReportedLocation {
  lat: unknown;
  lng: unknown;
  accuracyM: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Decide whether a reported location is acceptable. Inaccurate coordinates are never
 * silently accepted: accuracy worse than the limit is POOR_ACCURACY (retry), however
 * close the point looks. GPS can be spoofed, so this is a control, not proof of identity.
 */
export function evaluateLocation(campus: CampusGeo, reported: ReportedLocation): LocationEvaluation {
  if (campus.latitude === null || campus.longitude === null) {
    return { result: 'CAMPUS_NOT_CONFIGURED', distanceM: null, boundary: false };
  }
  const lat = finiteNumber(reported.lat);
  const lng = finiteNumber(reported.lng);
  const accuracy = finiteNumber(reported.accuracyM);
  if (
    lat === null || lng === null || accuracy === null ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracy < 0
  ) {
    return { result: 'NO_LOCATION', distanceM: null, boundary: false };
  }

  const distanceM = distanceMeters({ lat: campus.latitude, lng: campus.longitude }, { lat, lng });

  if (accuracy > campus.requiredAccuracyM) {
    return { result: 'POOR_ACCURACY', distanceM, boundary: false };
  }
  if (distanceM > campus.radiusM) {
    return { result: 'OUTSIDE_RADIUS', distanceM, boundary: false };
  }
  return { result: 'PASSED', distanceM, boundary: distanceM + accuracy > campus.radiusM };
}
