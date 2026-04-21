/**
 * Station-specific delay model using real DB delay data.
 *
 * Uses a lookup table with p_miss profiles for 3139 stations (221 FV, 2918 NV).
 * Falls back to a global model when station data is unavailable.
 * Data source: piebro/deutsche-bahn-data (CC BY 4.0), Dec 2025 – Feb 2026.
 */

import lookupData from "../../data/db_delay_lookup.min.json";

// --------------- Types ---------------

interface StationEntry {
  station: string;
  eva: string;
  category: string;
  n_samples: number;
  mean_delay: number;
  p_miss: Record<string, number>;
}

interface GlobalFallback {
  mixture_params: Record<string, number>;
  p_miss_profile: Record<string, number>;
  n_samples: number;
}

interface DelayLookup {
  meta: {
    transfer_times: number[];
    walk_time_assumed_min: number;
  };
  global_fallback: {
    FV: GlobalFallback;
    NV: GlobalFallback;
  };
  station_lookup: Record<string, StationEntry>;
}

const lookup = lookupData as unknown as DelayLookup;
const TRANSFER_TIMES = lookup.meta.transfer_times;

// --------------- Station name matching ---------------

// Pre-build a normalized name index for fuzzy matching
const normalizedIndex = new Map<string, string>();
for (const key of Object.keys(lookup.station_lookup)) {
  normalizedIndex.set(key.toLowerCase(), key);
  // Also index without parenthetical suffixes: "Aachen Hbf___FV"
  const normalized = normalizeName(key.split("___")[0]) + "___" + key.split("___")[1];
  if (!normalizedIndex.has(normalized.toLowerCase())) {
    normalizedIndex.set(normalized.toLowerCase(), key);
  }
}

function normalizeName(name: string): string {
  return name
    .replace(/\(.*?\)/g, "")  // Remove parenthetical like "(Westf)"
    .replace(/hauptbahnhof/gi, "Hbf")
    .replace(/ü/g, "ue").replace(/ä/g, "ae").replace(/ö/g, "oe")
    .replace(/Ü/g, "Ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

function findProfile(stationName: string, category: "FV" | "NV"): Record<string, number> {
  const key = `${stationName}___${category}`;

  // 1. Exact match
  if (lookup.station_lookup[key]) {
    return lookup.station_lookup[key].p_miss;
  }

  // 2. Case-insensitive match
  const ciMatch = normalizedIndex.get(key.toLowerCase());
  if (ciMatch && lookup.station_lookup[ciMatch]) {
    return lookup.station_lookup[ciMatch].p_miss;
  }

  // 3. Normalized match (remove parenthetical, Hbf normalization, umlauts)
  const normalizedKey = normalizeName(stationName) + "___" + category;
  const normMatch = normalizedIndex.get(normalizedKey.toLowerCase());
  if (normMatch && lookup.station_lookup[normMatch]) {
    return lookup.station_lookup[normMatch].p_miss;
  }

  // 4. Global fallback
  return lookup.global_fallback[category].p_miss_profile;
}

// --------------- Interpolation ---------------

function interpolatePMiss(profile: Record<string, number>, t: number): number {
  if (t <= TRANSFER_TIMES[0]) return profile[String(TRANSFER_TIMES[0])];
  if (t >= TRANSFER_TIMES[TRANSFER_TIMES.length - 1]) {
    return profile[String(TRANSFER_TIMES[TRANSFER_TIMES.length - 1])];
  }

  // Find surrounding support points
  let lower = TRANSFER_TIMES[0];
  let upper = TRANSFER_TIMES[TRANSFER_TIMES.length - 1];
  for (let i = 0; i < TRANSFER_TIMES.length - 1; i++) {
    if (TRANSFER_TIMES[i] <= t && TRANSFER_TIMES[i + 1] > t) {
      lower = TRANSFER_TIMES[i];
      upper = TRANSFER_TIMES[i + 1];
      break;
    }
  }

  const pLower = profile[String(lower)];
  const pUpper = profile[String(upper)];
  const ratio = (t - lower) / (upper - lower);
  return pLower + ratio * (pUpper - pLower);
}

// --------------- Category detection ---------------

function getCategory(incomingTrainType: string): "FV" | "NV" {
  const upper = incomingTrainType.toUpperCase();
  if (upper.startsWith("ICE") || upper.startsWith("IC") || upper.startsWith("EC") ||
      upper.startsWith("TGV") || upper.startsWith("RJ")) {
    return "FV";
  }
  return "NV";
}

// --------------- Public API ---------------

/**
 * P(miss connection) given transfer time, station name, and incoming train type.
 * Uses station-specific data when available, global fallback otherwise.
 */
export function pMissConnection(
  transferMinutes: number,
  incomingTrainType: string,
  stationName?: string
): number {
  const category = getCategory(incomingTrainType);
  const profile = stationName
    ? findProfile(stationName, category)
    : lookup.global_fallback[category].p_miss_profile;
  return interpolatePMiss(profile, transferMinutes);
}

/**
 * P(at least one missed connection) across all transfers.
 * = 1 - product(1 - p_miss_i)
 */
export function pRouteFailure(
  transfers: { transferMinutes: number; incomingTrainType: string; stationName?: string }[]
): number {
  if (transfers.length === 0) return 0;
  let pAllMade = 1;
  for (const t of transfers) {
    pAllMade *= 1 - pMissConnection(t.transferMinutes, t.incomingTrainType, t.stationName);
  }
  return 1 - pAllMade;
}
