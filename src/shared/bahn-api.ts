/**
 * Direct client for www.bahn.de/web/api/angebote/fahrplan
 *
 * Bypasses db-vendo-client entirely — calls the same endpoint bahn.de uses.
 * Correctly handles `zwischenhalte` (via stops).
 */

import { Journey, Station, ScanProgress, CandidateEntry, FVCandidateEntry, Phase1Result } from "./types";
import { createThrottle } from "./throttle";
import { getConfig } from "./config";

const BAHN_API = "https://int.bahn.de/web/api/angebote/fahrplan";
const throttle = createThrottle(2000);

// --------------- Raw response types ---------------

interface BahnVerkehrsmittel {
  produktGattung?: string;
  kategorie?: string;
  name?: string;
  nummer?: string;
  richtung?: string;
  typ?: string;
}

interface BahnAbschnitt {
  abfahrtsOrt?: string;
  ankunftsOrt?: string;
  abfahrtsZeitpunkt?: string;
  ankunftsZeitpunkt?: string;
  abfahrtsOrtExtId?: string;
  ankunftsOrtExtId?: string;
  verkehrsmittel?: BahnVerkehrsmittel;
  halte?: BahnHalt[];
  abfahrt?: { sollzeit?: string; progzeit?: string };
  ankunft?: { sollzeit?: string; progzeit?: string };
}

interface BahnHalt {
  id?: string;
  extId?: string;
  name?: string;
  ankunft?: { sollzeit?: string };
  abfahrt?: { sollzeit?: string };
}

interface BahnVerbindung {
  tripId?: string;
  verbindungsAbschnitte?: BahnAbschnitt[];
  angebotsPreis?: { betrag?: number; waehrung?: string };
  umstiegsAnzahl?: number;
  /** true = angebotsPreis covers only part of the route (e.g. FV-only Sparpreis on NV+FV journey) */
  hasTeilpreis?: boolean;
}

interface BahnApiResponse {
  verbindungen?: BahnVerbindung[];
  verbindungReference?: {
    earlier?: string;
    later?: string;
  };
}

// --------------- FV detection ---------------

const FV_PRODUCTS = new Set([
  "ice", "ic", "ec", "ece", "tgv", "rj", "rjx", "nj",
  "icee", "ice-sprinter",
]);

function getTrainCategory(product: string): "fv" | "nv" {
  return FV_PRODUCTS.has(product.toLowerCase()) ? "fv" : "nv";
}

function isFlixTrain(leg: { line: { product: string; name: string } }): boolean {
  const name = leg.line.name.toUpperCase();
  return name.startsWith("FLX ") || name.startsWith("FLX");
}

export function hasFlixTrain(journey: Journey): boolean {
  return journey.legs.some(isFlixTrain);
}

export function isFernverkehrLeg(leg: { line: { product: string; name: string } }): boolean {
  if (isFlixTrain(leg)) return false;
  const product = leg.line.product.toLowerCase();
  if (FV_PRODUCTS.has(product)) return true;
  if (product.includes("ice") || product.includes("fernverkehr")) return true;
  const name = leg.line.name.toUpperCase();
  if (name.startsWith("ICE ") || name.startsWith("IC ") || name.startsWith("EC ") || name.startsWith("TGV ")) return true;
  return false;
}

export function hasFernverkehr(journey: Journey): boolean {
  return journey.legs.some(isFernverkehrLeg);
}

/**
 * Returns true if journey has at least one NV leg.
 * Only NV-haltige journeys can be optimized via via-stops.
 */
export function isNVHaltig(journey: Journey): boolean {
  return journey.legs.some((leg) => !isFernverkehrLeg(leg));
}

/**
 * Returns true if ALL legs are FV trains (rein-FV = not optimizable).
 */
export function isReinFV(journey: Journey): boolean {
  return !isNVHaltig(journey);
}

// --------------- Structural equivalence ---------------

function getLegDurationMinutes(leg: { departure: string; arrival: string }): number {
  return Math.round(
    (new Date(leg.arrival).getTime() - new Date(leg.departure).getTime()) / 60000
  );
}

/**
 * Canonical structural key for a journey.
 * Two journeys with the same key are structurally equivalent.
 * Format: "fv:60:0s|nv:45:6s|fv:120:0s" (category:duration:stops per leg)
 * Stops count makes e.g. an RE with 6 stops structurally different from one with 1 stop.
 */
export function journeyStructuralKey(
  journey: Journey,
  stopMap?: Map<number, BahnStopover[]>
): string {
  // Key parts per leg: train category + 15-min duration bucket + full
  // alphabetically-sorted list of intermediate halte. Including the full
  // halte list (instead of just count) means two connections over different
  // physical routes no longer collapse into one key just because their leg
  // count and rough duration match — empirically halves the false-negative
  // rate on complex multi-path routes like Frankfurt↔München while not
  // introducing any false-positive splits (two schedule slots on the same
  // physical route still share a key as long as their duration lands in
  // the same 15-min bucket).
  return journey.legs
    .map((leg, idx) => {
      const cat = getTrainCategory(leg.line.product);
      const durMin = getLegDurationMinutes(leg);
      const durBucket = Math.round(durMin / 15) * 15;
      const halte = (stopMap?.get(idx) || [])
        .map((s) => s.station?.name)
        .filter((n): n is string => !!n)
        .sort()
        .join(",");
      return `${cat}:${durBucket}:${halte}`;
    })
    .join("|");
}

/**
 * Structural key for pure FV journeys.
 * Two FV journeys are "same" if total duration (15min bucket) AND
 * set of intermediate stop names are identical.
 */
export function fvStructuralKey(
  journey: Journey,
  stopMap?: Map<number, BahnStopover[]>
): string {
  const totalDur = Math.round(
    (new Date(journey.legs[journey.legs.length - 1].arrival).getTime() -
     new Date(journey.legs[0].departure).getTime()) / 60000
  );
  const durBucket = Math.round(totalDur / 15) * 15;

  // Collect the full halte list from stopMap (all intermediate stops across
  // all legs) plus each leg's destination (catches transfer stations that
  // aren't in halte). Same rationale as journeyStructuralKey: differentiate
  // physically different routes that happen to share total duration, while
  // still grouping schedule-slot siblings of the same physical service.
  const allStops = new Set<string>();
  if (stopMap) {
    for (const stopovers of stopMap.values()) {
      for (const s of stopovers) {
        if (s.station?.name) allStops.add(s.station.name);
      }
    }
  }
  for (const leg of journey.legs) {
    if (leg.destination?.name) allStops.add(leg.destination.name);
  }
  // Don't include origin/destination — they're the same for every connection
  // on a given route.
  allStops.delete(journey.origin.name);
  allStops.delete(journey.destination.name);

  return `fv:${durBucket}min|${[...allStops].sort().join(",")}`;
}

// --------------- Formatting helpers ---------------

function formatLid(stationId: string, stationName?: string): string {
  if (stationId.startsWith("A=")) return stationId;
  const name = stationName ? `@O=${stationName}` : "";
  return `A=1${name}@L=${stationId}@`;
}

function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// --------------- Convert bahn.de response to Journey ---------------

function bahnToJourney(v: BahnVerbindung): Journey | null {
  // Skip Teilpreis offers: the Sparpreis covers only a subset of the legs,
  // the rest must be booked separately. Not useful for Zugbindung-Aufhebung
  // since the user would still need another ticket for the uncovered part.
  if (v.hasTeilpreis === true && getConfig().filters.skipTeilpreis) return null;

  const abschnitte = v.verbindungsAbschnitte;
  if (!abschnitte || abschnitte.length === 0) return null;

  const trainLegs = abschnitte.filter(
    (a) => a.verkehrsmittel && a.verkehrsmittel.typ === "PUBLICTRANSPORT"
  );
  if (trainLegs.length === 0) return null;

  const firstLeg = trainLegs[0];
  const lastLeg = trainLegs[trainLegs.length - 1];

  return {
    type: "journey",
    id: v.tripId || "",
    origin: {
      id: firstLeg.abfahrtsOrtExtId || "",
      name: firstLeg.abfahrtsOrt || "",
    },
    destination: {
      id: lastLeg.ankunftsOrtExtId || "",
      name: lastLeg.ankunftsOrt || "",
    },
    legs: trainLegs.map((a) => ({
      origin: {
        id: a.abfahrtsOrtExtId || "",
        name: a.abfahrtsOrt || "",
      },
      destination: {
        id: a.ankunftsOrtExtId || "",
        name: a.ankunftsOrt || "",
      },
      departure: a.abfahrtsZeitpunkt || a.abfahrt?.sollzeit || "",
      arrival: a.ankunftsZeitpunkt || a.ankunft?.sollzeit || "",
      line: {
        id: a.verkehrsmittel?.nummer || "",
        name: a.verkehrsmittel?.name || "",
        product: a.verkehrsmittel?.produktGattung?.toLowerCase() || "",
      },
      halte: extractStopovers(a).map((s) => ({
        station: s.station,
        arrival: s.arrival,
        departure: s.departure,
      })),
    })),
    price: {
      currency: v.angebotsPreis?.waehrung || "EUR",
      amount: v.angebotsPreis?.betrag || 0,
      discount: false,
      name: "Sparpreis",
    },
  };
}

// --------------- Stopover extraction ---------------

export interface BahnStopover {
  station: Station;
  arrival: string | null;
  departure: string | null;
}

function extractStopovers(abschnitt: BahnAbschnitt): BahnStopover[] {
  if (!abschnitt.halte) return [];
  return abschnitt.halte
    .filter((h) => h.extId && h.name)
    .map((h) => ({
      station: { id: h.extId!, name: h.name! },
      arrival: h.ankunft?.sollzeit || null,
      departure: h.abfahrt?.sollzeit || null,
    }));
}

function extractStopoversMap(v: BahnVerbindung): Map<number, BahnStopover[]> {
  const stopMap = new Map<number, BahnStopover[]>();
  const trainLegs = (v.verbindungsAbschnitte || []).filter(
    (a) => a.verkehrsmittel?.typ === "PUBLICTRANSPORT"
  );
  trainLegs.forEach((a, idx) => {
    const stops = extractStopovers(a);
    if (stops.length > 0) stopMap.set(idx, stops);
  });
  return stopMap;
}

// --------------- Search body ---------------

function makeSearchBody(fromId: string, toId: string, date: Date): Record<string, unknown> {
  return {
    abfahrtsHalt: formatLid(fromId),
    ankunftsHalt: formatLid(toId),
    anfrageZeitpunkt: formatDateTime(date),
    ankunftSuche: "ABFAHRT",
    klasse: "KLASSE_2",
    reisende: [
      {
        typ: "ERWACHSENER",
        anzahl: 1,
        alter: [],
        ermaessigungen: [
          { art: "KEINE_ERMAESSIGUNG", klasse: "KLASSENLOS" },
        ],
      },
    ],
    schnelleVerbindungen: true,
    sitzplatzOnly: false,
    bikeCarriage: false,
    reservierungsKontingenteVorhanden: false,
  };
}

// --------------- Sampling logic ---------------

function sampleDates(dates: Date[], count: number): Date[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Days with >= 30 days lead time get weight 3, others weight 1
  const weighted: Date[] = [];
  for (const d of dates) {
    const daysUntil = Math.round(
      (d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );
    const weight = daysUntil >= 30 ? 3 : 1;
    for (let w = 0; w < weight; w++) weighted.push(d);
  }

  // Fisher-Yates shuffle
  for (let i = weighted.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [weighted[i], weighted[j]] = [weighted[j], weighted[i]];
  }

  // Deduplicate by date string and take first `count`
  const seen = new Set<string>();
  const result: Date[] = [];
  for (const d of weighted) {
    const key = d.toISOString().split("T")[0];
    if (!seen.has(key) && result.length < count) {
      seen.add(key);
      result.push(d);
    }
  }
  return result;
}

// --------------- Scan day window (18:00-02:00) ---------------

async function scanDayWindow(
  fromId: string,
  toId: string,
  date: Date,
  onVerbindung: (v: BahnVerbindung) => void
): Promise<number> {
  // Start: 18:00 on the given day
  const start = new Date(date);
  start.setHours(18, 0, 0, 0);

  // End: 02:00 next day
  const end = new Date(date);
  end.setDate(end.getDate() + 1);
  end.setHours(2, 0, 0, 0);

  let currentTime = start;
  let emptyCount = 0;
  let apiCalls = 0;
  // 2 statt 3: bahn.de liefert am Rand eines Zeitfensters oft 1-2 leere
  // 30-Min-Slots bevor der nächste Zug beginnt. 3 verschwendet noch einen
  // API-Call am Ende. 2 reicht — bahn.de packt bei bestehendem Angebot
  // im Window mindestens 1 Verbindung in jede 30-Min-Response.
  const MAX_EMPTY = 2;
  const seenDeps = new Set<string>();

  while (currentTime <= end && emptyCount < MAX_EMPTY) {
    const data = await throttle(() => callBahnApi(makeSearchBody(fromId, toId, currentTime)));
    apiCalls++;
    const verbindungen = data.verbindungen || [];

    if (verbindungen.length === 0) {
      emptyCount++;
      currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
      continue;
    }

    emptyCount = 0;
    for (const v of verbindungen) {
      // Deduplicate by departure time
      const dep = v.verbindungsAbschnitte?.[0]?.abfahrtsZeitpunkt;
      if (dep && !seenDeps.has(dep)) {
        seenDeps.add(dep);
        onVerbindung(v);
      }
    }

    // Next request: after last departure
    const lastDep = verbindungen[verbindungen.length - 1]
      ?.verbindungsAbschnitte?.[0]?.abfahrtsZeitpunkt;
    if (lastDep) {
      const lastDepTime = new Date(lastDep);
      currentTime = new Date(lastDepTime.getTime() + 1 * 60 * 1000);
    } else {
      currentTime = new Date(currentTime.getTime() + 60 * 60 * 1000);
    }
  }
  return apiCalls;
}

// --------------- Extended scan window (06:00-18:00) ---------------

async function scanDayWindowExtended(
  fromId: string,
  toId: string,
  date: Date,
  onVerbindung: (v: BahnVerbindung) => void
): Promise<number> {
  const start = new Date(date);
  start.setHours(6, 0, 0, 0);

  const end = new Date(date);
  end.setHours(18, 0, 0, 0);

  let currentTime = start;
  let emptyCount = 0;
  let apiCalls = 0;
  // 2 statt 3: bahn.de liefert am Rand eines Zeitfensters oft 1-2 leere
  // 30-Min-Slots bevor der nächste Zug beginnt. 3 verschwendet noch einen
  // API-Call am Ende. 2 reicht — bahn.de packt bei bestehendem Angebot
  // im Window mindestens 1 Verbindung in jede 30-Min-Response.
  const MAX_EMPTY = 2;
  const seenDeps = new Set<string>();

  while (currentTime <= end && emptyCount < MAX_EMPTY) {
    const data = await throttle(() => callBahnApi(makeSearchBody(fromId, toId, currentTime)));
    apiCalls++;
    const verbindungen = data.verbindungen || [];

    if (verbindungen.length === 0) {
      emptyCount++;
      currentTime = new Date(currentTime.getTime() + 30 * 60 * 1000);
      continue;
    }

    emptyCount = 0;
    for (const v of verbindungen) {
      const dep = v.verbindungsAbschnitte?.[0]?.abfahrtsZeitpunkt;
      if (dep && !seenDeps.has(dep)) {
        seenDeps.add(dep);
        onVerbindung(v);
      }
    }

    const lastDep = verbindungen[verbindungen.length - 1]
      ?.verbindungsAbschnitte?.[0]?.abfahrtsZeitpunkt;
    if (lastDep) {
      currentTime = new Date(new Date(lastDep).getTime() + 1 * 60 * 1000);
    } else {
      currentTime = new Date(currentTime.getTime() + 60 * 60 * 1000);
    }
  }
  return apiCalls;
}

// --------------- Day scan timing record (exported for DB logging) ---------------

export interface DayScanTiming {
  date: string;
  durationMs: number;
  apiCalls: number;
  phase: "standard" | "extended";
}

// --------------- Phase 1: Find cheapest NV-haltige journeys ---------------

export async function findCheapestJourneyBahn(
  fromId: string,
  toId: string,
  targetDate: Date,
  callbacks: {
    onProgress: (progress: ScanProgress) => void;
  }
): Promise<Phase1Result | null> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = new Date(targetDate);
  target.setHours(23, 59, 59, 999);

  if (target <= today) return null;

  const nearDateWarning =
    Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) < 7;

  // Generate all dates in range
  const allDates: Date[] = [];
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= target) {
    allDates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  if (allDates.length === 0) {
    callbacks.onProgress({
      phase: "error",
      current: 0,
      total: 0,
      message: "Kein gueltiger Zeitraum. Das Datum muss in der Zukunft liegen.",
    });
    return null;
  }

  // Sample 10 days (or all if < 10)
  const standardScanDays = getConfig().scan.standardDays;
  const sampled = allDates.length <= standardScanDays
    ? allDates
    : sampleDates(allDates, standardScanDays);

  // Scan: collect ALL connections, determine pMin afterwards
  let pMin = Infinity;
  const dayTimings: DayScanTiming[] = [];
  const byStructure = new Map<string, CandidateEntry>();
  const fvByStructure = new Map<string, FVCandidateEntry>();
  let foundAnyFVJourney = false;

  for (let i = 0; i < sampled.length; i++) {
    const date = sampled[i];
    const dayStart = Date.now();
    callbacks.onProgress({
      phase: "scanning",
      current: i + 1,
      total: sampled.length,
      message: `Suche guenstigste Verbindungen (Tag ${i + 1}/${sampled.length}, ${fmtDate(date)})...`,
    });

    const apiCalls = await scanDayWindow(fromId, toId, date, (v) => {
      const price = v.angebotsPreis?.betrag;
      if (!price || price <= 0) return;

      const journey = bahnToJourney(v);
      if (!journey) return;
      if (getConfig().filters.skipFlixTrain && hasFlixTrain(journey)) return;
      if (!hasFernverkehr(journey)) return; // must have at least 1 FV train

      foundAnyFVJourney = true;

      // pMin tracks the cheapest price across ALL connections (NV + FV)
      if (price < pMin) pMin = price;

      if (isReinFV(journey)) {
        // Collect pure FV connections separately, with stopovers for FV-only
        // optimization. Extract stopMap up-front since fvStructuralKey now
        // depends on the full halte list to tell different physical routes
        // apart.
        const stopMap = extractStopoversMap(v);
        const fvKey = fvStructuralKey(journey, stopMap);
        const existing = fvByStructure.get(fvKey);
        if (!existing || price < existing.price) {
          fvByStructure.set(fvKey, { journey, stopovers: stopMap, structuralKey: fvKey, price });
        }
        return;
      }

      // Extract stopovers
      const stopMap = extractStopoversMap(v);

      const structKey = journeyStructuralKey(journey, stopMap);
      const existing = byStructure.get(structKey);

      // Keep cheapest price per structure
      if (!existing || price < existing.price) {
        byStructure.set(structKey, {
          journey,
          stopovers: stopMap,
          structuralKey: structKey,
          price,
        });
      }
    });
    const dayMs = Date.now() - dayStart;
    dayTimings.push({ date: fmtDate(date), durationMs: dayMs, apiCalls, phase: "standard" });
    console.log(`[scan-timing] Day ${i + 1}/${sampled.length} (${fmtDate(date)}): ${dayMs}ms, ${apiCalls} API calls`);
  }
  console.log(`[scan-timing] Phase 1 complete: ${sampled.length} days, ${byStructure.size} NV structures, ${fvByStructure.size} FV structures`);

  // Check results
  if (byStructure.size === 0) {
    if (foundAnyFVJourney) {
      // Found FV journeys but all are rein-FV — still return them for Phase 3
      const fvCandidates = Array.from(fvByStructure.values()).sort((a, b) => a.price - b.price);
      return {
        candidates: [],
        fvCandidates,
        pMin: pMin === Infinity ? (fvCandidates[0]?.price || 0) : pMin,
        allReinFV: fvCandidates.length > 0,
        nearDateWarning,
        dayTimings,
      };
    }
    return null; // route doesn't exist
  }

  // Filter: keep structures up to pCapExt so extended scan has candidates too
  const cfg = getConfig();
  const pCap = cfg.price.capMultiplier * pMin;
  const pCapExt = cfg.price.capExtMultiplier * pMin;
  const candidates = Array.from(byStructure.values())
    .filter((c) => c.price <= pCapExt)
    .sort((a, b) => a.price - b.price);

  // FV candidates: filter up to pCapExt
  const fvCandidates = Array.from(fvByStructure.values())
    .filter((c) => c.price <= pCapExt)
    .sort((a, b) => a.price - b.price);

  if (candidates.length === 0 && fvCandidates.length === 0) {
    return null;
  }

  // If no NV candidates but we have FV candidates
  if (candidates.length === 0 && fvCandidates.length > 0) {
    return {
      candidates: [],
      fvCandidates,
      pMin,
      allReinFV: true,
      nearDateWarning,
      dayTimings,
    };
  }

  const nvUnderCap = candidates.filter(c => c.price <= pCap).length;
  const fvUnderCap = fvCandidates.filter(c => c.price <= pCap).length;
  console.log(`[findCheapest] pMin=${pMin}€, pCap=${pCap}€, pCapExt=${pCapExt}€. Found ${nvUnderCap}+${candidates.length - nvUnderCap} NV-haltige + ${fvUnderCap}+${fvCandidates.length - fvUnderCap} rein-FV (under pCap + under pCapExt)`);

  return {
    candidates,
    fvCandidates,
    pMin,
    allReinFV: false,
    nearDateWarning,
    dayTimings,
  };
}

// --------------- Extended Phase 1 (06:00-18:00, 5 days) ---------------


export async function findCheapestJourneyBahnExtended(
  fromId: string,
  toId: string,
  targetDate: Date,
  priceLimit: number,
  alreadyKnownKeys: Set<string>,
  alreadyKnownFVKeys: Set<string>,
  onProgress: (p: ScanProgress) => void
): Promise<{ nvCandidates: CandidateEntry[]; fvCandidates: FVCandidateEntry[]; dayTimings: DayScanTiming[] }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const target = new Date(targetDate);
  target.setHours(23, 59, 59, 999);

  const allDates: Date[] = [];
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= target) {
    allDates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const extendedScanDays = getConfig().scan.extendedDays;
  const sampled = allDates.length <= extendedScanDays
    ? allDates
    : sampleDates(allDates, extendedScanDays);

  // Fill-up target: each scanned day should contribute at least this many
  // candidates for downstream optimization, even if none of them have
  // structurally new keys. Priority order per day:
  //   1. Connections with keys not yet seen (Phase 1 + already-collected
  //      extended candidates)
  //   2. If < MIN_PER_DAY new-key picks, fill with the cheapest
  //      already-known-key connections from the same day
  // This is what makes Step 4 productive even when Phase 1 has already
  // exhausted the distinct structural variants on a route: the additional
  // Via-Stop experiments run against a now-enriched stop pool and can find
  // winner-pairs that the original Phase 2 pass missed.
  const MIN_PER_DAY = 3;

  const nvOut: CandidateEntry[] = [];
  const fvOut: FVCandidateEntry[] = [];
  const globalSeenDep = new Set<string>(); // dedupe same exact connection
  // Running set of keys we've already collected across days, so day N+1's
  // "new key" check considers days 1..N as already known.
  const collectedNVKeys = new Set<string>();
  const collectedFVKeys = new Set<string>();
  const extDayTimings: DayScanTiming[] = [];

  for (let i = 0; i < sampled.length; i++) {
    const date = sampled[i];
    const dayStart = Date.now();
    onProgress({
      phase: "extended_scanning",
      current: i + 1,
      total: sampled.length,
      message: `Erweiterte Suche (Tag ${i + 1}/${sampled.length}, ${fmtDate(date)})...`,
    });

    // Pass 1 of 2: collect every valid FV-containing connection from the day.
    // Defer picking / dedup until we have the whole day's inventory so we
    // can sort by price and apply the fill-up logic below.
    type DayConn = {
      journey: Journey;
      price: number;
      stopMap: Map<number, BahnStopover[]>;
      structKey: string;
      reinFV: boolean;
      depTime: string;
    };
    const dayPool: DayConn[] = [];

    const apiCalls = await scanDayWindowExtended(fromId, toId, date, (v) => {
      const price = v.angebotsPreis?.betrag;
      if (!price || price <= 0 || price > priceLimit) return;

      const journey = bahnToJourney(v);
      if (!journey) return;
      if (getConfig().filters.skipFlixTrain && hasFlixTrain(journey)) return;
      if (!hasFernverkehr(journey)) return;

      const stopMap = extractStopoversMap(v);
      const reinFV = isReinFV(journey);
      const structKey = reinFV
        ? fvStructuralKey(journey, stopMap)
        : journeyStructuralKey(journey, stopMap);
      const depTime = journey.legs[0]?.departure ?? "";

      dayPool.push({ journey, price, stopMap, structKey, reinFV, depTime });
    });

    // Sort day's pool by price — cheapest first. Both new-key picking and
    // filler picking should prefer the cheapest concrete connections.
    dayPool.sort((a, b) => a.price - b.price);

    // Pass 2: select picks with priority for new keys, then fill.
    const pickedDepTimes = new Set<string>();
    const pickedKeysThisDay = new Set<string>();
    const picks: DayConn[] = [];

    // Priority 1 — genuinely new keys (no cap).
    for (const c of dayPool) {
      const alreadyKnownGlobally = c.reinFV
        ? alreadyKnownFVKeys.has(c.structKey) || collectedFVKeys.has(c.structKey)
        : alreadyKnownKeys.has(c.structKey) || collectedNVKeys.has(c.structKey);
      if (alreadyKnownGlobally) continue;
      if (pickedKeysThisDay.has(c.structKey)) continue; // only one per key per day
      pickedKeysThisDay.add(c.structKey);
      pickedDepTimes.add(c.depTime);
      picks.push(c);
    }

    // Priority 2 — fill with cheapest remaining (any key) until MIN_PER_DAY.
    if (picks.length < MIN_PER_DAY) {
      for (const c of dayPool) {
        if (picks.length >= MIN_PER_DAY) break;
        if (pickedDepTimes.has(c.depTime)) continue;
        pickedDepTimes.add(c.depTime);
        picks.push(c);
      }
    }

    // Commit picks to global output + running collected-keys sets.
    for (const c of picks) {
      if (globalSeenDep.has(c.depTime)) continue;
      globalSeenDep.add(c.depTime);
      if (c.reinFV) {
        collectedFVKeys.add(c.structKey);
        fvOut.push({
          journey: c.journey,
          stopovers: c.stopMap,
          structuralKey: c.structKey,
          price: c.price,
        });
      } else {
        collectedNVKeys.add(c.structKey);
        nvOut.push({
          journey: c.journey,
          stopovers: c.stopMap,
          structuralKey: c.structKey,
          price: c.price,
        });
      }
    }

    const dayMs = Date.now() - dayStart;
    extDayTimings.push({ date: fmtDate(date), durationMs: dayMs, apiCalls, phase: "extended" });
    console.log(
      `[scan-timing] Extended day ${i + 1}/${sampled.length} (${fmtDate(date)}): ` +
      `${dayMs}ms, ${apiCalls} API calls, ${dayPool.length} pool → ${picks.length} picks`
    );
  }

  // Final sort by price across all days.
  nvOut.sort((a, b) => a.price - b.price);
  fvOut.sort((a, b) => a.price - b.price);

  console.log(
    `[scan-timing] Extended scan complete: ${sampled.length} days, ` +
    `${nvOut.length} NV + ${fvOut.length} FV candidates (including fillers)`
  );

  return {
    nvCandidates: nvOut,
    fvCandidates: fvOut,
    dayTimings: extDayTimings,
  };
}

// --------------- Public API: Search with via stops ---------------

export async function searchJourneysWithVia(
  fromId: string,
  toId: string,
  viaStops: Station[],
  departure: Date | string,
  aufenthaltsdauer = 2
): Promise<Journey[]> {
  const dep = typeof departure === "string" ? new Date(departure) : departure;

  const body = {
    abfahrtsHalt: formatLid(fromId),
    ankunftsHalt: formatLid(toId),
    anfrageZeitpunkt: formatDateTime(dep),
    ankunftSuche: "ABFAHRT",
    klasse: "KLASSE_2",
    reisende: [
      {
        typ: "ERWACHSENER",
        anzahl: 1,
        alter: [],
        ermaessigungen: [
          { art: "KEINE_ERMAESSIGUNG", klasse: "KLASSENLOS" },
        ],
      },
    ],
    zwischenhalte: viaStops.map((s) => ({
      id: formatLid(s.id, s.name),
      aufenthaltsdauer,
    })),
    schnelleVerbindungen: true,
    sitzplatzOnly: false,
    bikeCarriage: false,
    reservierungsKontingenteVorhanden: false,
  };

  const data = await throttle(() => callBahnApi(body));

  const journeys: Journey[] = [];
  for (const v of data.verbindungen || []) {
    const j = bahnToJourney(v);
    if (j) journeys.push(j);
  }

  return journeys;
}

// --------------- Rate limit tracking ---------------

let rlRequestCount = 0;
let rlFirstRequestAt = 0;
let rlLastRequestAt = 0;
let rlLast429At = 0;
let rl429Count = 0;

// --------------- Internal HTTP call ---------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 5000;

async function callBahnApi(body: Record<string, unknown>): Promise<BahnApiResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const now = Date.now();
    if (rlFirstRequestAt === 0) rlFirstRequestAt = now;
    rlRequestCount++;
    rlLastRequestAt = now;

    // Browser-realistic headers to avoid bot detection.
    // Origin + Referer are also enforced via declarativeNetRequest rules in manifest.
    const secChUa = typeof navigator !== "undefined" && "userAgentData" in navigator
      ? (navigator as unknown as { userAgentData: { brands: { brand: string; version: string }[] } })
          .userAgentData.brands.map(b => `"${b.brand}";v="${b.version}"`).join(", ")
      : `"Chromium";v="131", "Not_A Brand";v="24"`;

    const res = await fetch(BAHN_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
        "Origin": "https://www.bahn.de",
        "Referer": "https://www.bahn.de/",
        "Sec-Ch-Ua": secChUa,
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": `"Windows"`,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "Priority": "u=1, i",
      },
      body: JSON.stringify(body),
      // `int.bahn.de/web/api/angebote/fahrplan` is a public endpoint and
      // doesn't need user cookies. We OMIT credentials so that if bahn.de
      // ever wires authentication onto this endpoint, the extension can't
      // be weaponised as a cross-origin CSRF vector acting as the logged-in
      // bahn.de user (combined with the declarativeNetRequest Origin-spoof
      // that would otherwise be concerning).
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 429) {
      rl429Count++;
      const sinceLast429 = rlLast429At ? ((now - rlLast429At) / 1000).toFixed(1) : "n/a";
      const sinceFirst = ((now - rlFirstRequestAt) / 1000).toFixed(1);
      const avgInterval = rlRequestCount > 1 ? ((now - rlFirstRequestAt) / (rlRequestCount - 1) / 1000).toFixed(2) : "n/a";
      console.warn(
        `[bahn-api] 429 RATE LIMITED | ` +
        `requests since start: ${rlRequestCount} in ${sinceFirst}s (avg ${avgInterval}s/req) | ` +
        `429 #${rl429Count} | since last 429: ${sinceLast429}s`
      );
      rlLast429At = now;

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        console.log(`[bahn-api] Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`bahn.de API rate limit (429) after ${MAX_RETRIES} retries`);
    }

    if (!res.ok && res.status !== 201) {
      const text = await res.text();
      throw new Error(`bahn.de API error ${res.status} (via ${BAHN_API}): ${text.substring(0, 200)}`);
    }

    return res.json() as Promise<BahnApiResponse>;
  }

  throw new Error("Unexpected end of retry loop");
}
