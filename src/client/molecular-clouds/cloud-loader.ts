import * as THREE from 'three';

export type CloudSource = 'Z2021T1' | 'Z2020';

export interface Cloud {
  name: string;
  id: string;
  /** Absolute ICRS heliocentric position in parsecs. */
  centerAbs: THREE.Vector3;
  /** Semi-axes in parsecs along the cloud's local x, y, z. Equal for sphere clouds. */
  axes: [number, number, number];
  /** Orientation of the local frame relative to ICRS. Identity for sphere clouds. */
  quat: THREE.Quaternion;
  source: CloudSource;
  /** Heliocentric distance to the centroid in pc — precomputed for hover labels. */
  distanceFromSol: number;
}

export interface CloudCatalog {
  count: number;
  clouds: Cloud[];
}

interface RawCloud {
  name: string;
  id: string;
  center: [number, number, number];
  axes: [number, number, number];
  quat: [number, number, number, number];
  source: CloudSource;
  distance: number;
}

interface RawCatalog {
  version: number;
  count: number;
  clouds: RawCloud[];
}

/**
 * Fetch the molecular cloud catalog. Returns null if the file is missing
 * (fresh checkout without `npm run build:clouds`, or a deploy that didn't
 * include the artifact). Callers must treat null as "no clouds layer", not
 * an error.
 */
export async function loadClouds(url: string): Promise<CloudCatalog | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const raw = (await res.json()) as RawCatalog;
  if (raw.version !== 1) {
    console.warn(`clouds.json version ${raw.version} unsupported`);
    return null;
  }
  const clouds: Cloud[] = raw.clouds.map((c) => ({
    name: c.name,
    id: c.id,
    centerAbs: new THREE.Vector3(c.center[0], c.center[1], c.center[2]),
    axes: [c.axes[0], c.axes[1], c.axes[2]],
    quat: new THREE.Quaternion(c.quat[0], c.quat[1], c.quat[2], c.quat[3]),
    source: c.source,
    distanceFromSol: c.distance,
  }));
  return { count: raw.count, clouds };
}
