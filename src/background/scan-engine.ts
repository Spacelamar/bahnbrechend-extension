/**
 * Scan orchestration engine for the browser extension.
 *
 * Extracted from src/app/api/optimize/route.ts and adapted:
 * - No DB operations (ScanLogger, scan_results, scan_queue)
 * - No SSE streaming — uses callbacks (onProgress, onResult)
 * - No server-side lock/heartbeat — uses AbortSignal for cancellation
 * - Experiments collected in a local array and returned as ScanAnalytics
 */

import {
  findCheapestJourneyBahn,
  findCheapestJourneyBahnExtended,
  BahnStopover,
  isFernverkehrLeg,
} from "../shared/bahn-api";
import {
  generateCandidateConfigs,
  buildNVStopPool,
  verifyConfigs,
  ExperimentLog,
} from "../shared/optimizer";
import { getConfig, loadConfig, snapshotConfig, releaseConfig } from "../shared/config";
import type {
  LegWithStopovers,
  Stopover,
  VerifiedConfig,
  CandidateEntry,
  FVCandidateEntry,
  OptimizeResult,
  ScanProgress,
  Station,
  Journey,
  RealSegment,
  TransferDetail,
} from "../shared/types";
import type { ZPair, ZPairUpdate } from "../shared/zpair-types";
import { calculateZScore } from "../shared/zpair-types";

// All formerly-hardcoded tuning constants (scan depths, candidate counts,
// score thresholds, pCap multipliers) now live in the remote config — see
// shared/config.ts. Read them at call time via getConfig().

/**
 * Pool-size threshold beyond which FV-Seed experiments are skipped.
 *
 * The FV-Seed step spawns 5 random experiments per FV candidate to
 * discover NV legs that enrich the shared stop pool. When the pool is
 * already large (>100 stops) the enrichment value collapses — historical
 * data shows the seed step produces strictly-better hits in only ~1% of
 * scans at Pool 100-200 and 0% at Pool 200+. At the same time the seeds
 * consume 40-80 API calls per extended scan (~115s wall time).
 *
 * With scan-wide dedup (v1.2.5) the random picker in generateCandidate-
 * Configs is already well-fed by the main fv_phase2 + ext_fv_phase2 runs
 * — the seed step becomes almost pure overhead past this threshold.
 */
const FV_SEED_POOL_SKIP_THRESHOLD = 100;

// ============================================================
// ExperimentRecord — enriched experiment data for analytics
// ============================================================

export interface ExperimentRecord {
  phase: string;
  candidateIndex: number;
  experimentIndex: number;
  viaStopIds: string[];
  viaStopNames: string[];
  viaStopCount: number;
  originalPrice: number;
  originalLegCount: number;
  originalNVLegCount: number;
  originalFVLegCount: number;
  originalStructuralKey: string;
  originalTrainProducts: string[];
  outcome: string;
  resultPrice?: number;
  resultScore?: number;
  resultShortestTransfer?: number;
  resultSameTrains?: boolean;
  resultLegCount?: number;
  resultTrainNames?: string[];
  durationMs: number;
  priceVsOriginal?: number;
  // Transfer-level detail for retrospective score/zPair analysis
  transfers?: TransferDetail[];
  transferCount?: number;
  originalTransfers?: TransferDetail[];
  originalTransferCount?: number;
  // zPair provenance — did this pair come from the persistent route pool?
  fromZPairCache?: boolean;
  zpairPriorZscore?: number;
  context: Record<string, unknown>;
}

// ============================================================
// Public interfaces
// ============================================================

export interface ScanParams {
  fromId: string;
  toId: string;
  date: string;       // YYYY-MM-DD
  isExtended: boolean;
  topZPairs: ZPair[];
  signal: AbortSignal;
  onProgress: (progress: ScanProgress) => void;
  onResult: (result: OptimizeResult) => void;
  /** If provided, skip Phase 1+2 and jump straight to the Extended-Scan
   *  logic using the saved state from a previous scan on the same route.
   *  Used when the user clicks "Score verbessern" — avoids re-running
   *  the ~6 min of Phase 1+2 work that already succeeded. */
  inheritedState?: InheritedScanState;
}

export interface ScanAnalytics {
  scanData: Record<string, unknown>;
  experiments: ExperimentRecord[];
  zPairUpdates: ZPairUpdate[];
}

// ============================================================
// Inherited state — shape persisted to chrome.storage.session at the
// end of each scan, so a subsequent manual extended scan ("Score
// verbessern") can pick up where the previous one left off.
// ============================================================

/** Serializable form of CandidateEntry (stopovers Map → array of entries). */
export interface SerializableCandidate {
  journey: Journey;
  stopoversEntries: [number, import("../shared/bahn-api").BahnStopover[]][];
  structuralKey: string;
  price: number;
}

export interface InheritedScanState {
  fromId: string;
  toId: string;
  dateStr: string;
  timestamp: number;             // ms since epoch — for staleness check
  pMin: number;
  pCap: number;
  pCapExt: number;
  nearDateWarning: boolean;
  allReinFV: boolean;
  nvStructuresFound: number;
  fvStructuresFound: number;
  candidates: SerializableCandidate[];
  fvCandidates: SerializableCandidate[];
  allVerified: VerifiedConfig[];
  allExtendedCandidates: VerifiedConfig[];
  sharedStopPool: Station[];
  highScoreConfigs: VerifiedConfig[];
  highScoreSeen: string[];
  /** Via-stop pair keys already sent to bahn.de in the previous scan.
   *  Avoids re-testing them when the user clicks "Score verbessern" —
   *  the extended-scan will skip these and pick fresh pairs instead. */
  testedPairs: string[];
}

function serializeCandidate(c: CandidateEntry | FVCandidateEntry): SerializableCandidate {
  return {
    journey: c.journey,
    stopoversEntries: [...c.stopovers.entries()],
    structuralKey: c.structuralKey,
    price: c.price,
  };
}

export function deserializeCandidate(s: SerializableCandidate): CandidateEntry {
  return {
    journey: s.journey,
    stopovers: new Map(s.stopoversEntries),
    structuralKey: s.structuralKey,
    price: s.price,
  };
}

// ============================================================
// Helper: check cancellation via AbortSignal
// ============================================================

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("cancelled");
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Early termination: 3+ configs at or above `scoring.ideal`
 * AND at least one of those priced at or below pMin * `price.earlyTerminateMultiplier`.
 */
function shouldEarlyTerminate(configs: VerifiedConfig[], pMin: number): boolean {
  const cfg = getConfig();
  const idealConfigs = configs.filter((c) => c.score >= cfg.scoring.ideal);
  if (idealConfigs.length < 3) return false;
  return idealConfigs.some((c) => c.totalPrice <= pMin * cfg.price.earlyTerminateMultiplier);
}

function mapBahnStopovers(raw: BahnStopover[]): Stopover[] {
  return raw
    .filter((s) => s.station.id && s.station.name)
    .map((s) => ({
      station: { id: s.station.id, name: s.station.name },
      arrival: s.arrival ?? null,
      departure: s.departure ?? null,
      arrivalDelay: null,
      departureDelay: null,
    }));
}

function buildLegsWithStopovers(entry: CandidateEntry): LegWithStopovers[] {
  return entry.journey.legs.map((leg, idx) => ({
    ...leg,
    stopovers: entry.stopovers.has(idx)
      ? mapBahnStopovers(entry.stopovers.get(idx)!)
      : [],
  }));
}

function deduplicateConfigs(configs: VerifiedConfig[]): VerifiedConfig[] {
  const seen = new Set<string>();
  return configs.filter((c) => {
    const key = `${c.totalPrice.toFixed(2)}-${(c.score * 1000).toFixed(0)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildResult(
  journey: Journey | null,
  date: string,
  configs: VerifiedConfig[],
  pMin: number,
  pCap: number,
  bestScore: number,
  extendedScanAvailable: boolean,
  extendedScanAutoStarted: boolean,
  allReinFV: boolean,
  nearDateWarning: boolean,
  isExtendedResult: boolean
): OptimizeResult {
  return {
    journey, date, configs, pMin, pCap, bestScore,
    extendedScanAvailable, extendedScanAutoStarted,
    allReinFV, nearDateWarning, isExtendedResult,
  };
}

// ============================================================
// enrichExperimentLogs — enrich raw ExperimentLog with context
// ============================================================

/** Enrich experiment logs from optimizer with candidate context for analytics */
function enrichExperimentLogs(
  logs: ExperimentLog[],
  phase: string,
  candidateIndex: number,
  journey: Journey,
  structuralKey: string,
  searchDate?: string,
  pMin?: number,
  pCapExt?: number,
): ExperimentRecord[] {
  const legCount = journey.legs.length;
  const nvLegCount = journey.legs.filter((l) => !isFernverkehrLeg(l)).length;
  const fvLegCount = legCount - nvLegCount;
  const trainProducts = [...new Set(journey.legs.map((l) => l.line.product))];
  const originalPrice = journey.price.amount;

  // Compute NV ratio by duration (not just leg count)
  let totalDurationMs = 0;
  let nvDurationMs = 0;
  for (const leg of journey.legs) {
    const dur = new Date(leg.arrival).getTime() - new Date(leg.departure).getTime();
    totalDurationMs += dur;
    if (!isFernverkehrLeg(leg)) nvDurationMs += dur;
  }
  const nvRatio = totalDurationMs > 0 ? nvDurationMs / totalDurationMs : 0;
  const totalDurationMin = Math.round(totalDurationMs / 60000);

  // Departure info
  const depDate = new Date(journey.legs[0]?.departure || "");
  const departureHour = depDate.getHours();
  const dayOfWeek = depDate.getDay();

  // Days until travel
  const daysUntil = searchDate
    ? Math.round((depDate.getTime() - new Date(searchDate + "T00:00").getTime()) / 86400000)
    : undefined;

  // Build a map of all stopovers on the original route for position lookup
  // Each stopover gets a normalized position 0.0 (start) to 1.0 (end)
  const routeStopMap = new Map<string, { position: number; legIndex: number; isNVLeg: boolean }>();
  let totalStopsOnRoute = 0;
  for (let li = 0; li < journey.legs.length; li++) {
    const leg = journey.legs[li];
    const isNV = !isFernverkehrLeg(leg);
    // Add from/to of each leg
    if (!routeStopMap.has(leg.origin.id)) {
      routeStopMap.set(leg.origin.id, { position: 0, legIndex: li, isNVLeg: isNV });
    }
    if (!routeStopMap.has(leg.destination.id)) {
      routeStopMap.set(leg.destination.id, { position: 0, legIndex: li, isNVLeg: isNV });
    }
    // Add halte (intermediate stops)
    if (leg.halte) {
      for (const h of leg.halte) {
        if (!routeStopMap.has(h.station.id)) {
          routeStopMap.set(h.station.id, { position: 0, legIndex: li, isNVLeg: isNV });
        }
      }
    }
  }
  // Assign normalized positions (0.0 = origin, 1.0 = destination)
  totalStopsOnRoute = routeStopMap.size;
  if (totalStopsOnRoute > 1) {
    let idx = 0;
    for (const entry of routeStopMap.values()) {
      entry.position = idx / (totalStopsOnRoute - 1);
      idx++;
    }
  }

  /** Classify station type from name */
  function classifyStopType(name: string): string {
    const n = name.toLowerCase();
    if (n.includes("hbf") || n.endsWith(" hauptbahnhof")) return "hbf";
    if (n.includes("bahnhof") || n.endsWith(" bf")) return "bf";
    if (/\bS\d/.test(name) || n.includes("s-bahn")) return "s-bahn";
    if (n.includes("bus") || n.includes("zob")) return "bus";
    return "other";
  }

  return logs.map((log) => {
    // Everything in this callback is best-effort — if enrichment blows up
    // on an edge case (missing station name, malformed halte), we still
    // want the core experiment row to land in the DB with a recorded
    // `enrichmentError` marker instead of a silent NULL context.
    try {
      return enrichOne(log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[enrichExperimentLogs] failed:", message, log.viaStops);
      return buildFallbackRecord(log, phase, candidateIndex, originalPrice,
        legCount, nvLegCount, fvLegCount, structuralKey, trainProducts, message);
    }
  });

  function enrichOne(log: ExperimentLog): ExperimentRecord {
    let resolvedPhase = phase;
    if (phase.startsWith("fv_") || phase.startsWith("ext_fv_")) {
      if (log.isWinner !== undefined) {
        const prefix = phase.startsWith("ext_") ? "ext_fv_" : "fv_";
        resolvedPhase = log.isWinner ? `${prefix}winner` : `${prefix}random`;
      }
    }

    const resolvedCandidateIndex = log.fvConnectionIndex ?? candidateIndex;

    // --- Stop-level properties for cluster analysis ---
    const stops = log.viaStops;
    const stop1Info = stops[0] ? routeStopMap.get(stops[0].id) : undefined;
    const stop2Info = stops[1] ? routeStopMap.get(stops[1].id) : undefined;

    const stop1Type = stops[0] ? classifyStopType(stops[0].name) : undefined;
    const stop2Type = stops[1] ? classifyStopType(stops[1].name) : undefined;
    const stop1OnRoute = !!stop1Info;
    const stop2OnRoute = !!stop2Info;
    const stop1RoutePosition = stop1Info?.position ?? null;
    const stop2RoutePosition = stop2Info?.position ?? null;
    const stop1FromNVLeg = stop1Info?.isNVLeg ?? null;
    const stop2FromNVLeg = stop2Info?.isNVLeg ?? null;

    const bothOnRoute = stop1OnRoute && stop2OnRoute;
    const bothOnSameLeg = bothOnRoute && stop1Info!.legIndex === stop2Info!.legIndex;
    const positionSpread = (stop1RoutePosition !== null && stop2RoutePosition !== null)
      ? Math.round(Math.abs(stop1RoutePosition - stop2RoutePosition) * 100) / 100
      : null;
    const pairTypeCombo = (stop1Type && stop2Type) ? `${stop1Type}+${stop2Type}` : undefined;

    // Build context for analytics
    const context: ExperimentRecord["context"] = {
      originalNVRatio: Math.round(nvRatio * 100) / 100,
      originalDurationMin: totalDurationMin,
      originalDepartureHour: departureHour,
      dayOfWeek,
      daysUntilTravel: daysUntil,
      // Stop properties
      stop1Type, stop2Type,
      stop1OnRoute, stop2OnRoute,
      stop1RoutePosition, stop2RoutePosition,
      stop1FromNVLeg, stop2FromNVLeg,
      bothOnRoute, bothOnSameLeg,
      positionSpread, pairTypeCombo,
      // Retry info
      retried: log.retried,
      aufenthaltsdauer: log.aufenthaltsdauer,
      // zPair provenance (also persisted as top-level columns, but
      // keeping in context too makes historical JSONB queries work
      // without joining back to the new columns)
      isZPairWinner: log.fromZPairCache,
    };

    // Result quality (if experiment produced a result)
    if (log.resultScore !== undefined && log.resultTrainNames) {
      context.resultTrainTypeSequence = log.resultTrainNames.map((n: string) => {
        const u = n.toUpperCase();
        if (u.startsWith("ICE")) return "ICE";
        if (u.startsWith("IC ") || u.startsWith("EC ")) return "IC";
        if (u.startsWith("RE")) return "RE";
        if (u.startsWith("RB")) return "RB";
        if (/^S\d/.test(u)) return "S";
        if (u.startsWith("BUS")) return "Bus";
        return "Other";
      }).join("-");

      if (log.resultLegCount !== undefined) {
        context.legCountDiff = log.resultLegCount - legCount;
      }
    }

    // zScore (if we have the data)
    if (log.resultScore !== undefined && log.resultPrice !== undefined && pMin !== undefined && pCapExt !== undefined) {
      context.zScore = calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt);
    }

    return {
      phase: resolvedPhase,
      candidateIndex: resolvedCandidateIndex,
      experimentIndex: log.experimentIndex,
      viaStopIds: log.viaStops.map((s) => s.id),
      viaStopNames: log.viaStops.map((s) => s.name),
      viaStopCount: log.viaStops.length,
      originalPrice,
      originalLegCount: legCount,
      originalNVLegCount: nvLegCount,
      originalFVLegCount: fvLegCount,
      originalStructuralKey: structuralKey,
      originalTrainProducts: trainProducts,
      outcome: log.outcome,
      resultPrice: log.resultPrice,
      resultScore: log.resultScore,
      resultShortestTransfer: log.resultShortestTransfer,
      resultSameTrains: log.resultSameTrains,
      resultLegCount: log.resultLegCount,
      resultTrainNames: log.resultTrainNames,
      durationMs: log.durationMs,
      priceVsOriginal: log.resultPrice && originalPrice > 0
        ? Math.round((log.resultPrice / originalPrice) * 100) / 100
        : undefined,
      transfers: log.resultTransfers,
      transferCount: log.resultTransferCount ?? log.resultTransfers?.length,
      originalTransfers: log.originalTransfers,
      originalTransferCount: log.originalTransferCount ?? log.originalTransfers?.length,
      fromZPairCache: log.fromZPairCache,
      zpairPriorZscore: log.zpairPriorZscore,
      context,
    };
  }
}

/** Minimum-viable record when enrichment throws — keeps the core fields
 *  so the row is still useful, marks the failure in context. */
function buildFallbackRecord(
  log: ExperimentLog,
  phase: string,
  candidateIndex: number,
  originalPrice: number,
  legCount: number,
  nvLegCount: number,
  fvLegCount: number,
  structuralKey: string,
  trainProducts: string[],
  enrichmentError: string,
): ExperimentRecord {
  return {
    phase,
    candidateIndex: log.fvConnectionIndex ?? candidateIndex,
    experimentIndex: log.experimentIndex,
    viaStopIds: log.viaStops.map((s) => s.id),
    viaStopNames: log.viaStops.map((s) => s.name),
    viaStopCount: log.viaStops.length,
    originalPrice,
    originalLegCount: legCount,
    originalNVLegCount: nvLegCount,
    originalFVLegCount: fvLegCount,
    originalStructuralKey: structuralKey,
    originalTrainProducts: trainProducts,
    outcome: log.outcome,
    resultPrice: log.resultPrice,
    resultScore: log.resultScore,
    resultShortestTransfer: log.resultShortestTransfer,
    durationMs: log.durationMs,
    transfers: log.resultTransfers,
    transferCount: log.resultTransferCount ?? log.resultTransfers?.length,
    originalTransfers: log.originalTransfers,
    originalTransferCount: log.originalTransferCount ?? log.originalTransfers?.length,
    fromZPairCache: log.fromZPairCache,
    zpairPriorZscore: log.zpairPriorZscore,
    context: { enrichmentError },
  };
}

// ============================================================
// extractPoolFromRealSegments
// ============================================================

/** Extract station pool from RealSegments (uses halte from bahn.de API) */
function extractPoolFromRealSegments(
  segments: RealSegment[],
  existingPool: Set<string>
): Station[] {
  const newStops: Station[] = [];
  for (const seg of segments) {
    // Add from/to of each segment
    for (const station of [seg.from, seg.to]) {
      if (!existingPool.has(station.id)) {
        existingPool.add(station.id);
        newStops.push(station);
      }
    }
    // Add intermediate stops from bahn.de halte
    if (seg.halte) {
      for (const halt of seg.halte) {
        if (!existingPool.has(halt.station.id)) {
          existingPool.add(halt.station.id);
          newStops.push(halt.station);
        }
      }
    }
  }
  return newStops;
}

// ============================================================
// runExtendedScan
// ============================================================

interface ExtendedScanResult {
  configs: VerifiedConfig[];
  zPairUpdates: ZPairUpdate[];
}

async function runExtendedScan(
  fromId: string,
  toId: string,
  targetDate: Date,
  knownCandidates: CandidateEntry[],
  knownFVCandidates: FVCandidateEntry[],
  pMin: number,
  pCap: number,
  pCapExt: number,
  alreadyFoundExtCandidates: VerifiedConfig[],
  topZPairs: ZPair[],
  onProgress: (p: ScanProgress) => void,
  signal: AbortSignal,
  experiments: ExperimentRecord[],
  inheritedStopPool?: Station[],
  // Callback so that high-score configs found DURING the extended scan
  // (not just in Phase 2) are visible to the 90%-fallback at end-of-scan.
  collectHighScore?: (configs: VerifiedConfig[]) => void,
  // Callback to bump the outer progress tracker's callsDone counter —
  // without this, the ~100+ API calls that the extended scan now makes
  // via verifyConfigs go uncounted and the UI's remaining-time estimate
  // gets stuck.
  bumpCallsDone?: () => void,
  // Scan-wide dedup set — shared with Phase 2. Every pair we generate
  // here is recorded; pairs already tested in Phase 2 are skipped.
  testedPairs?: Set<string>
): Promise<ExtendedScanResult> {
  const results: VerifiedConfig[] = [...alreadyFoundExtCandidates];
  const extZPairUpdates: ZPairUpdate[] = [];
  const dateStr = targetDate.toISOString().split("T")[0];

  // Shared progress-callback for every verifyConfigs call inside the
  // extended scan. Bumps the outer callsDone counter and emits an
  // `extended_verifying` progress event so the UI's remaining-time
  // estimate actually moves. Without this, the 100+ API calls that Steps
  // 2/3/5/6 make during extended-scan are invisible to the ProgressBar
  // and the "Noch X Sekunden" text freezes at the last value from Phase 2.
  function verifyProgressCb(cur: number, tot: number) {
    bumpCallsDone?.();
    checkAborted(signal);
    onProgress({
      phase: "extended_verifying",
      current: cur,
      total: tot,
      message: `Erweiterte Optimierung (${cur}/${tot})...`,
    });
  }

  // Shared stop pool — start with inherited pool from Phase 2
  const extStopPool: Station[] = [...(inheritedStopPool || [])];
  const extSeen = new Set(extStopPool.map(s => s.id));

  function addToExtPool(stops: Station[]) {
    for (const s of stops) {
      if (!extSeen.has(s.id)) {
        extSeen.add(s.id);
        extStopPool.push(s);
      }
    }
  }

  // Step 1: Gather candidates
  const maxCandidatesPerPass = getConfig().scan.maxCandidatesPerPass;
  // Known NV between pCap and pCapExt
  const overCapNV = knownCandidates
    .filter((c) => c.price > pCap && c.price <= pCapExt)
    .slice(0, maxCandidatesPerPass);

  // Known FV between pCap and pCapExt
  const overCapFV = knownFVCandidates
    .filter((c) => c.price > pCap && c.price <= pCapExt)
    .slice(0, maxCandidatesPerPass);

  const overPCapExtNV = knownCandidates.filter((c) => c.price > pCapExt).length;
  const overPCapExtFV = knownFVCandidates.filter((c) => c.price > pCapExt).length;
  console.log(
    `[extended] Candidates: ${overCapNV.length} NV + ${overCapFV.length} FV between pCap(${pCap.toFixed(0)}€) and pCapExt(${pCapExt.toFixed(0)}€)` +
    ` | Skipped (>pCapExt): ${overPCapExtNV} NV + ${overPCapExtFV} FV`
  );

  const alreadyTestedKeys = new Set(
    knownCandidates.filter((c) => c.price <= pCap).map((c) => c.structuralKey)
  );
  const alreadyTestedFVKeys = new Set(
    knownFVCandidates.map((c) => c.structuralKey)
  );

  // Step 2: Test overCap NV candidates (same as Phase 2a)
  for (let ci = 0; ci < overCapNV.length; ci++) {
    checkAborted(signal);
    const entry = overCapNV[ci];
    onProgress({
      phase: "extended_verifying",
      current: ci + 1,
      total: overCapNV.length,
      message: `Pruefe weitere Verbindungen (${ci + 1}/${overCapNV.length})...`,
    });

    const legs = buildLegsWithStopovers(entry);
    addToExtPool(buildNVStopPool(legs));
    const exps = generateCandidateConfigs(extStopPool, topZPairs, fromId, toId, testedPairs);
    if (exps.length === 0) continue;

    const result = await verifyConfigs(exps, entry.journey, {
      originalPrice: entry.price, pMin, pCap, pCapExt,
    }, verifyProgressCb);
    results.push(...result.standard);
    results.push(...result.extendedCandidates);
    collectHighScore?.(result.allWithTransfers);
    for (const config of result.allWithTransfers) {
      const nvSegs = config.realSegments.filter(seg => !isFernverkehrLeg({ line: { product: "", name: seg.trainName } }));
      addToExtPool(extractPoolFromRealSegments(nvSegs, new Set()));
    }

    for (const log of result.experimentLogs) {
      if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
        extZPairUpdates.push({
          stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
          stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
          zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
        });
      }
    }

    experiments.push(
      ...enrichExperimentLogs(result.experimentLogs, "ext_nv", ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
    );
  }

  // Step 3: Test overCap FV candidates (same as Phase 2b with FV seed)
  for (let ci = 0; ci < overCapFV.length; ci++) {
    checkAborted(signal);
    const entry = overCapFV[ci];
    onProgress({
      phase: "extended_verifying",
      current: ci + 1,
      total: overCapFV.length,
      message: `Pruefe FV-Verbindungen (${ci + 1}/${overCapFV.length})...`,
    });

    // Add FV stopovers to shared pool
    for (const [, stops] of entry.stopovers) {
      addToExtPool(stops.map(s => s.station));
    }
    if (extStopPool.length < 2) continue;

    // FV Seed Step — skip when pool is already well-filled (same
    // threshold as Step 6 and Phase 2b; see constant comment). When
    // Extended runs on top of inherited state the pool typically starts
    // at ~140 stops, so Step-3 seed is almost always redundant.
    const skipStep3Seed = extStopPool.length > FV_SEED_POOL_SKIP_THRESHOLD;
    if (skipStep3Seed) {
      console.log(`[ext-step3-seed] Skipping seed step: pool has ${extStopPool.length} stops (> ${FV_SEED_POOL_SKIP_THRESHOLD})`);
    }
    const seedExperiments = skipStep3Seed
      ? []
      : generateCandidateConfigs(extStopPool, [], fromId, toId, testedPairs).slice(0, 5);
    if (seedExperiments.length > 0) {
      const seedResult = await verifyConfigs(seedExperiments, entry.journey, {
        originalPrice: entry.price, pMin, pCap, pCapExt,
      }, verifyProgressCb);

      for (const log of seedResult.experimentLogs) {
        if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
          extZPairUpdates.push({
            stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
            stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
            zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
          });
        }
      }

      experiments.push(
        ...enrichExperimentLogs(seedResult.experimentLogs, "ext_fv_seed", ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
      );

      results.push(...seedResult.standard);
      results.push(...seedResult.extendedCandidates);
      collectHighScore?.(seedResult.allWithTransfers);

      // Enrich pool from NV leg halte
      for (const config of seedResult.allWithTransfers) {
        const nvSegs = config.realSegments.filter(
          (seg) => !isFernverkehrLeg({ line: { product: "", name: seg.trainName } })
        );
        addToExtPool(extractPoolFromRealSegments(nvSegs, new Set()));
      }
    }

    // Main FV experiments with enriched pool
    const mainExperiments = generateCandidateConfigs(extStopPool, topZPairs, fromId, toId, testedPairs);
    if (mainExperiments.length > 0) {
      const result = await verifyConfigs(mainExperiments, entry.journey, {
        originalPrice: entry.price, pMin, pCap, pCapExt,
      }, verifyProgressCb);
      results.push(...result.standard);
      results.push(...result.extendedCandidates);
      collectHighScore?.(result.allWithTransfers);

      for (const log of result.experimentLogs) {
        if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
          extZPairUpdates.push({
            stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
            stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
            zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
          });
        }
      }

      experiments.push(
        ...enrichExperimentLogs(result.experimentLogs, "ext_fv_phase2", ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
      );
    }
  }

  // Step 4: Scan new time window (06:00-18:00)
  checkAborted(signal);
  onProgress({
    phase: "extended_scanning",
    current: 0, total: 5,
    message: "Erweiterte Suche (Tagesverbindungen)...",
  });

  const { nvCandidates: newNV, fvCandidates: newFV } =
    await findCheapestJourneyBahnExtended(
      fromId, toId, targetDate, pCapExt, alreadyTestedKeys, alreadyTestedFVKeys,
      (p) => onProgress(p)
    );

  // Step 5: Test new NV candidates (same as Phase 2a)
  for (let ci = 0; ci < Math.min(newNV.length, maxCandidatesPerPass); ci++) {
    checkAborted(signal);
    const entry = newNV[ci];
    onProgress({
      phase: "extended_verifying",
      current: ci + 1,
      total: newNV.length,
      message: `Optimiere neue NV-Verbindungen (${ci + 1}/${newNV.length})...`,
    });

    const legs = buildLegsWithStopovers(entry);
    addToExtPool(buildNVStopPool(legs));
    const exps = generateCandidateConfigs(extStopPool, topZPairs, fromId, toId, testedPairs);
    if (exps.length === 0) continue;

    const result = await verifyConfigs(exps, entry.journey, {
      originalPrice: entry.price, pMin, pCap, pCapExt,
    }, verifyProgressCb);
    results.push(...result.standard);
    results.push(...result.extendedCandidates);
    collectHighScore?.(result.allWithTransfers);
    for (const config of result.allWithTransfers) {
      const nvSegs = config.realSegments.filter(seg => !isFernverkehrLeg({ line: { product: "", name: seg.trainName } }));
      addToExtPool(extractPoolFromRealSegments(nvSegs, new Set()));
    }

    for (const log of result.experimentLogs) {
      if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
        extZPairUpdates.push({
          stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
          stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
          zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
        });
      }
    }

    experiments.push(
      ...enrichExperimentLogs(result.experimentLogs, "ext_nv", overCapNV.length + ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
    );
  }

  // Step 6: Test new FV candidates (same as Phase 2b with FV seed)
  const newFVUnderCap = newFV.filter((c) => c.price <= pCapExt).slice(0, getConfig().scan.maxFvCandidates);
  for (let ci = 0; ci < newFVUnderCap.length; ci++) {
    checkAborted(signal);
    const entry = newFVUnderCap[ci];
    onProgress({
      phase: "extended_verifying",
      current: ci + 1,
      total: newFVUnderCap.length,
      message: `Optimiere neue FV-Verbindungen (${ci + 1}/${newFVUnderCap.length})...`,
    });

    for (const [, stops] of entry.stopovers) {
      addToExtPool(stops.map(s => s.station));
    }
    if (extStopPool.length < 2) continue;

    // FV Seed — skip when pool is already well-filled (see constant comment).
    // In extended scans this is the more common case: the pool has grown
    // through Phase 1+2 + earlier extended steps, so seeding past 100 stops
    // mostly burns API budget without finding new NV legs.
    const skipExtSeed = extStopPool.length > FV_SEED_POOL_SKIP_THRESHOLD;
    if (skipExtSeed) {
      console.log(`[ext-fv-seed] Skipping seed step: pool has ${extStopPool.length} stops (> ${FV_SEED_POOL_SKIP_THRESHOLD})`);
    }
    const seedExps = skipExtSeed
      ? []
      : generateCandidateConfigs(extStopPool, [], fromId, toId, testedPairs).slice(0, 5);
    if (seedExps.length > 0) {
      const seedResult = await verifyConfigs(seedExps, entry.journey, {
        originalPrice: entry.price, pMin, pCap, pCapExt,
      }, verifyProgressCb);
      results.push(...seedResult.standard);
      results.push(...seedResult.extendedCandidates);

      for (const log of seedResult.experimentLogs) {
        if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
          extZPairUpdates.push({
            stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
            stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
            zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
          });
        }
      }

      experiments.push(
        ...enrichExperimentLogs(seedResult.experimentLogs, "ext_fv_seed", overCapFV.length + ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
      );

      // Enrich pool from NV leg halte
      for (const config of seedResult.allWithTransfers) {
        const nvSegs = config.realSegments.filter(
          (seg) => !isFernverkehrLeg({ line: { product: "", name: seg.trainName } })
        );
        addToExtPool(extractPoolFromRealSegments(nvSegs, new Set()));
      }
    }

    // Main FV experiments
    const mainExps = generateCandidateConfigs(extStopPool, topZPairs, fromId, toId, testedPairs);
    if (mainExps.length > 0) {
      const result = await verifyConfigs(mainExps, entry.journey, {
        originalPrice: entry.price, pMin, pCap, pCapExt,
      }, verifyProgressCb);
      results.push(...result.standard);
      results.push(...result.extendedCandidates);

      for (const log of result.experimentLogs) {
        if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
          extZPairUpdates.push({
            stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
            stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
            zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
          });
        }
      }

      experiments.push(
        ...enrichExperimentLogs(result.experimentLogs, "ext_fv_phase2", overCapFV.length + ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
      );
    }
  }

  return { configs: results, zPairUpdates: extZPairUpdates };
}

// ============================================================
// runScan — main entry point
// ============================================================

export async function runScan(params: ScanParams): Promise<ScanAnalytics> {
  const { fromId, toId, date: dateStr, isExtended, topZPairs, signal, onProgress, onResult, inheritedState } = params;

  // Fire-and-forget config refresh for the NEXT scan. This scan runs
  // against a frozen snapshot taken immediately below, so a refresh that
  // lands mid-scan cannot change classification between early and late
  // results of the same scan.
  void loadConfig();
  snapshotConfig();

  const targetDate = new Date(dateStr);
  const scanStart = Date.now();
  const scanData: Record<string, unknown> = {
    fromId,
    toId,
    searchDate: dateStr,
    // Extension version at scan-time — lets us distinguish "logged null
    // because client was v1.1" from "logged null because hit had no data".
    extensionVersion: chrome.runtime.getManifest().version,
  };
  const allExperiments: ExperimentRecord[] = [];
  const zPairUpdates: ZPairUpdate[] = [];

  // --- Progress tracker: API-call based estimation ---
  const pt = { callsDone: 0, estimatedTotal: 100 };
  let lastScanDay = 0;

  /** Wrap onProgress to auto-attach apiCallsDone/apiCallsEstimatedTotal */
  function sendProgress(p: ScanProgress) {
    if ((p.phase === "scanning" || p.phase === "extended_scanning") && p.current > lastScanDay) {
      pt.callsDone += 3;
      lastScanDay = p.current;
    }
    if (p.phase !== "done" && p.phase !== "error") {
      p.apiCallsDone = pt.callsDone;
      p.apiCallsEstimatedTotal = Math.max(pt.estimatedTotal, pt.callsDone + 1);
    }
    onProgress(p);
  }

  let allVerified: VerifiedConfig[] = [];
  let allExtendedCandidates: VerifiedConfig[] = [];
  let bestScore = 0;
  let pMin = 0;
  let pCap = 0;
  let pCapExt = 0;
  let nearDateWarning = false;
  let allReinFV = false;
  let candidates: CandidateEntry[] = [];
  let fvCandidates: FVCandidateEntry[] = [];

  // Shared stop pool — populated either from Phase 1+2 fresh scan, or
  // restored from inheritedState when the user clicks "Score verbessern".
  // Consumed by the Extended-Scan step below.
  const sharedStopPool: Station[] = [];
  const sharedSeen = new Set<string>();

  /** Add stops to the shared pool (deduplicates by station id). */
  function addToSharedPool(stops: Station[]) {
    for (const s of stops) {
      if (!sharedSeen.has(s.id)) {
        sharedSeen.add(s.id);
        sharedStopPool.push(s);
      }
    }
  }

  // High-score configs (>=80%) collected regardless of price — used as
  // fallback if no results land under pCapExt. Also reused across the
  // Phase 1+2 → Extended boundary, and inherited from a previous scan
  // when "Score verbessern" is clicked.
  const highScoreConfigs: VerifiedConfig[] = [];
  const highScoreSeen = new Set<string>();
  const FALLBACK_SCORE_MIN = 0.80;

  function collectHighScore(configs: VerifiedConfig[]) {
    for (const c of configs) {
      if (c.score >= FALLBACK_SCORE_MIN) {
        const key = `${c.totalPrice.toFixed(2)}-${(c.score * 1000).toFixed(0)}`;
        if (!highScoreSeen.has(key)) {
          highScoreSeen.add(key);
          highScoreConfigs.push(c);
        }
      }
    }
  }

  // Scan-wide dedup: we never ship the same via-stop pair to bahn.de
  // twice in one scan run. Historical data showed ~18% of API calls
  // were exact duplicates (same pair tested again in fv_phase2 after
  // fv_seed, or re-rolled by the random picker in a later candidate's
  // generate call). `generateCandidateConfigs` reads and writes this
  // set directly — any pair it emits is added, any pair already in the
  // set is skipped. Restored from inheritedState on "Score verbessern".
  const testedPairs = new Set<string>();

  try {
    if (inheritedState) {
      // Reuse state from the previous scan on the same route — skip
      // Phase 1+2 entirely and jump straight to the Extended-Scan below.
      // This path runs when the user clicks "Score verbessern", which
      // passes the last scan's accumulated state via scan_start_extended.
      pMin = inheritedState.pMin;
      pCap = inheritedState.pCap;
      pCapExt = inheritedState.pCapExt;
      nearDateWarning = inheritedState.nearDateWarning;
      allReinFV = inheritedState.allReinFV;
      candidates = inheritedState.candidates.map(deserializeCandidate);
      fvCandidates = inheritedState.fvCandidates.map(deserializeCandidate) as FVCandidateEntry[];
      allVerified = [...inheritedState.allVerified];
      allExtendedCandidates = [...inheritedState.allExtendedCandidates];

      // Restore shared pool (insertion order = priority, so route stop by stop)
      for (const s of inheritedState.sharedStopPool) addToSharedPool([s]);

      // Restore high-score pool + dedup keys so collectHighScore doesn't re-add
      highScoreConfigs.push(...inheritedState.highScoreConfigs);
      for (const k of inheritedState.highScoreSeen) highScoreSeen.add(k);

      // Restore scan-wide dedup so "Score verbessern" doesn't repeat any
      // pair that was already tried in the previous Phase 1+2 run.
      for (const k of inheritedState.testedPairs || []) testedPairs.add(k);

      bestScore = allVerified.length > 0 ? allVerified[0].score : 0;

      scanData.inheritedFromPreviousScan = true;
      scanData.inheritedAgeMs = Date.now() - inheritedState.timestamp;
      scanData.pMin = pMin;
      scanData.pCap = pCap;
      scanData.pCapExt = pCapExt;
      scanData.nvStructuresFound = inheritedState.nvStructuresFound;
      scanData.fvStructuresFound = inheritedState.fvStructuresFound;
      scanData.allReinFV = allReinFV;
      scanData.nearDateWarning = nearDateWarning;
      scanData.fromName = candidates[0]?.journey.origin.name || fvCandidates[0]?.journey.origin.name;
      scanData.toName = candidates[0]?.journey.destination.name || fvCandidates[0]?.journey.destination.name;
      scanData.inheritedVerifiedCount = allVerified.length;
      scanData.inheritedSharedPoolSize = sharedStopPool.length;
      scanData.inheritedHighScoreCount = highScoreConfigs.length;

      console.log(
        `[scan] Inherited state: ${candidates.length} NV + ${fvCandidates.length} FV candidates, ` +
        `pool ${sharedStopPool.length} stops, ${allVerified.length} verified, ` +
        `${highScoreConfigs.length} high-score configs — skipping Phase 1+2`
      );

      // API-call budget: only the Extended-scan portion remains
      const scanCfgInh = getConfig().scan;
      const extCallBudgetInh =
        scanCfgInh.extendedDays * 6 +
        scanCfgInh.maxCandidatesPerPass * 10 +
        scanCfgInh.maxFvCandidates * 15;
      pt.estimatedTotal = pt.callsDone + extCallBudgetInh;
    } else {
    // --- PHASE 1: Find cheapest NV-haltige journeys ---
    checkAborted(signal);
    sendProgress({
      phase: "scanning", current: 0, total: 10,
      message: "Suche guenstigste Verbindungen...",
    });

    const phase1 = await findCheapestJourneyBahn(fromId, toId, targetDate, {
      onProgress: (p) => { checkAborted(signal); sendProgress(p); },
    });

    const phase1End = Date.now();
    scanData.phase1DurationMs = phase1End - scanStart;

    // No route found at all
    if (phase1 === null) {
      scanData.errorMessage = "Keine Verbindung gefunden";
      scanData.terminationReason = "no_connection";
      return { scanData, experiments: allExperiments, zPairUpdates };
    }

    ({ candidates, fvCandidates, pMin, nearDateWarning } = { ...phase1 });
    allReinFV = phase1.allReinFV;

    scanData.daysScanned = getConfig().scan.standardDays;
    scanData.pMin = pMin;
    scanData.nvStructuresFound = candidates.length;
    scanData.fvStructuresFound = fvCandidates.length;
    scanData.allReinFV = allReinFV;
    scanData.nearDateWarning = nearDateWarning;
    scanData.fromName = candidates[0]?.journey.origin.name || fvCandidates[0]?.journey.origin.name;
    scanData.toName = candidates[0]?.journey.destination.name || fvCandidates[0]?.journey.destination.name;

    // All FV, no FV candidates found at all
    if (allReinFV && fvCandidates.length === 0) {
      scanData.terminationReason = "all_fv_no_candidates";
      onResult(buildResult(
        null, dateStr, [], 0, 0, 0,
        false, false, true, nearDateWarning, false
      ));
      return { scanData, experiments: allExperiments, zPairUpdates };
    }

    const cfgPrice = getConfig().price;
    const maxCandidatesPerPass = getConfig().scan.maxCandidatesPerPass;
    const capMul = cfgPrice.capMultiplier;
    const capExtMul = cfgPrice.capExtMultiplier;
    pCap = pMin > 0 ? capMul * pMin : (fvCandidates.length > 0 ? capMul * fvCandidates[0].price : 0);
    pCapExt = pMin > 0 ? capExtMul * pMin : (fvCandidates.length > 0 ? capExtMul * fvCandidates[0].price : 0);
    scanData.pCap = pCap;
    scanData.pCapExt = pCapExt;

    // ============================================================
    // UNIFIED OPTIMIZATION PIPELINE (NV + FV)
    // Uses persistent zPair pool for winners + random exploration
    // ============================================================

    console.log(`[zpair] Using ${topZPairs.length} winners for route`);

    // ALL candidates under pCap: NV + FV unified
    const standardCandidates = candidates
      .filter((c) => c.price <= pCap)
      .slice(0, maxCandidatesPerPass);

    const fvUnderCap = fvCandidates
      .filter((c) => c.price <= pCap)
      .slice(0, getConfig().scan.maxFvCandidates);

    const totalCandidates = standardCandidates.length + fvUnderCap.length;

    let phase2CandidatesTested = 0;
    let phase2ExperimentsGenerated = 0;

    // Pre-fill shared pool with NV-leg stopovers from ALL candidates (incl. over-pCap)
    // These stops are valid via-stop candidates even if the original connection is expensive
    for (const entry of candidates) {
      const legs = buildLegsWithStopovers(entry);
      addToSharedPool(buildNVStopPool(legs));
    }
    // Also add FV stopovers from ALL FV candidates
    for (const entry of fvCandidates) {
      for (const [, stops] of entry.stopovers) {
        addToSharedPool(stops.map(s => s.station));
      }
    }

    // Update progress estimate now that we know candidate counts
    pt.estimatedTotal = pt.callsDone
      + (standardCandidates.length * 8)
      + (fvUnderCap.length * 12)
      + 15; // extended scan buffer

    // --- PHASE 2: Unified NV+FV optimization ---
    if (totalCandidates > 0) {
      let candidateIdx = 0;

      // Phase 2a: NV-haltige candidates
      for (let ci = 0; ci < standardCandidates.length; ci++) {
        checkAborted(signal);
        const entry = standardCandidates[ci];
        candidateIdx++;

        sendProgress({
          phase: "optimizing",
          current: candidateIdx,
          total: totalCandidates,
          message: `Optimiere Verbindung ${candidateIdx}/${totalCandidates}...`,
        });

        const legs = buildLegsWithStopovers(entry);
        addToSharedPool(buildNVStopPool(legs));
        const exps = generateCandidateConfigs(sharedStopPool, topZPairs, fromId, toId, testedPairs);
        phase2ExperimentsGenerated += exps.length;

        if (exps.length === 0) continue;

        phase2CandidatesTested++;

        const result = await verifyConfigs(
          exps,
          entry.journey,
          { originalPrice: entry.price, pMin, pCap, pCapExt },
          (cur, tot) => {
            pt.callsDone++;
            sendProgress({
              phase: "verifying",
              current: cur,
              total: tot,
              message: `Pruefe Konfigurationen (${cur}/${tot})...`,
              subMessage: "Bahn API wird abgefragt.",
            });
          }
        );

        // Log experiments with candidate context
        allExperiments.push(
          ...enrichExperimentLogs(result.experimentLogs, "nv_verify", ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
        );

        // Collect zPair updates for persistent pool
        for (const log of result.experimentLogs) {
          if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
            zPairUpdates.push({
              stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
              stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
              zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
            });
          }
        }

        allVerified.push(...result.standard);
        allExtendedCandidates.push(...result.extendedCandidates);

        // Enrich shared pool + collect high-score configs
        collectHighScore(result.allWithTransfers);
        for (const config of result.allWithTransfers) {
          const nvSegs = config.realSegments.filter(seg => !isFernverkehrLeg({ line: { product: "", name: seg.trainName } }));
          addToSharedPool(extractPoolFromRealSegments(nvSegs, new Set()));
        }

        const localBest = result.standard.length > 0
          ? Math.max(...result.standard.map((c) => c.score))
          : 0;
        if (localBest > bestScore) bestScore = localBest;

        // Early termination: 3+ ideal scores AND at least one near pMin
        if (shouldEarlyTerminate(allVerified, pMin)) {
          scanData.phase2EarlyTerminated = true;
          scanData.phase2TerminatedAfterCandidate = ci;
          break;
        }
      }

      // Phase 2b: FV candidates
      for (let ci = 0; ci < fvUnderCap.length; ci++) {
        checkAborted(signal);
        const entry = fvUnderCap[ci];
        candidateIdx++;

        if (shouldEarlyTerminate(allVerified, pMin)) break;

        sendProgress({
          phase: "optimizing",
          current: candidateIdx,
          total: totalCandidates,
          message: `Optimiere FV-Verbindung ${candidateIdx}/${totalCandidates}...`,
        });

        // Add this FV candidate's stopovers to the shared pool
        for (const [, stops] of entry.stopovers) {
          addToSharedPool(stops.map(s => s.station));
        }

        if (sharedStopPool.length < 2) continue;

        // --- FV Seed Step: 5 random experiments from shared pool to discover NV legs ---
        // Skip entirely when the pool is already well-filled (see constant
        // comment). Saves ~5 API calls × N FV candidates with <1% hit-quality
        // cost past Pool 100.
        const skipSeed = sharedStopPool.length > FV_SEED_POOL_SKIP_THRESHOLD;
        if (skipSeed) {
          console.log(`[fv-seed] Skipping seed step: pool has ${sharedStopPool.length} stops (> ${FV_SEED_POOL_SKIP_THRESHOLD})`);
        }
        const seedExperiments = skipSeed
          ? []
          : generateCandidateConfigs(sharedStopPool, [], fromId, toId, testedPairs).slice(0, 5);
        phase2ExperimentsGenerated += seedExperiments.length;

        if (seedExperiments.length > 0) {
          phase2CandidatesTested++;

          const seedResult = await verifyConfigs(
            seedExperiments,
            entry.journey,
            { originalPrice: entry.price, pMin, pCap, pCapExt },
            (cur, tot) => {
              pt.callsDone++;
              sendProgress({
                phase: "verifying",
                current: cur, total: tot,
                message: `FV-Seed (${cur}/${tot})...`,
              });
            }
          );

          // Collect seed results + zPair updates
          for (const log of seedResult.experimentLogs) {
            if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
              zPairUpdates.push({
                stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
                stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
                zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
              });
            }
          }

          allExperiments.push(
            ...enrichExperimentLogs(seedResult.experimentLogs, "fv_seed", ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
          );

          allVerified.push(...seedResult.standard);
          allExtendedCandidates.push(...seedResult.extendedCandidates);

          // Enrich shared pool + collect high-score configs
          collectHighScore(seedResult.allWithTransfers);
          for (const config of seedResult.allWithTransfers) {
            const nvSegments = config.realSegments.filter(
              (seg) => !isFernverkehrLeg({ line: { product: "", name: seg.trainName } })
            );
            if (nvSegments.length === 0) continue;
            addToSharedPool(extractPoolFromRealSegments(nvSegments, new Set()));
          }

          console.log(`[fv-seed] Pool after seed: ${sharedStopPool.length} stops (seed found ${seedResult.standard.length} results)`);

          const seedBest = seedResult.standard.length > 0
            ? Math.max(...seedResult.standard.map((c) => c.score))
            : 0;
          if (seedBest > bestScore) bestScore = seedBest;
        }

        // --- Normal Phase 2b: winners + random from enriched pool ---
        const mainExperiments = generateCandidateConfigs(sharedStopPool, topZPairs, fromId, toId, testedPairs);
        phase2ExperimentsGenerated += mainExperiments.length;

        if (mainExperiments.length === 0) continue;

        const result = await verifyConfigs(
          mainExperiments,
          entry.journey,
          { originalPrice: entry.price, pMin, pCap, pCapExt },
          (cur, tot) => {
            pt.callsDone++;
            sendProgress({
              phase: "verifying",
              current: cur, total: tot,
              message: `Pruefe FV-Konfigurationen (${cur}/${tot})...`,
            });
          }
        );

        // Collect zPair updates
        for (const log of result.experimentLogs) {
          if (log.viaStops.length >= 2 && log.resultScore !== undefined && log.resultPrice !== undefined) {
            zPairUpdates.push({
              stop1: { id: log.viaStops[0].id, name: log.viaStops[0].name },
              stop2: { id: log.viaStops[1].id, name: log.viaStops[1].name },
              zScore: calculateZScore(log.resultScore, log.resultPrice, pMin, pCapExt),
            });
          }
        }

        allExperiments.push(
          ...enrichExperimentLogs(result.experimentLogs, "fv_phase2", ci, entry.journey, entry.structuralKey, dateStr, pMin, pCapExt)
        );

        allVerified.push(...result.standard);
        allExtendedCandidates.push(...result.extendedCandidates);

        // Enrich shared pool + collect high-score configs
        collectHighScore(result.allWithTransfers);
        for (const config of result.allWithTransfers) {
          const nvSegs = config.realSegments.filter(seg => !isFernverkehrLeg({ line: { product: "", name: seg.trainName } }));
          addToSharedPool(extractPoolFromRealSegments(nvSegs, new Set()));
        }

        const localBest = result.standard.length > 0
          ? Math.max(...result.standard.map((c) => c.score))
          : 0;
        if (localBest > bestScore) bestScore = localBest;
      }
    }

    const phase2End = Date.now();
    scanData.phase2DurationMs = phase2End - phase1End;
    scanData.phase2CandidatesTested = phase2CandidatesTested;
    scanData.phase2ExperimentsGenerated = phase2ExperimentsGenerated;

    // Deduplicate and sort
    allVerified = deduplicateConfigs(allVerified);
    allVerified.sort((a, b) => b.score - a.score);
    if (allVerified.length > 0) bestScore = allVerified[0].score;

    // Persist state so a future "Score verbessern" click can skip
    // Phase 1+2 and jump straight to Extended. Saved BEFORE decision
    // logic so the state captures a "Phase 1+2 done" snapshot that
    // feeds cleanly into the Extended-Scan wherever it runs from.
    if (candidates.length > 0 || fvCandidates.length > 0) {
      const stateToSave: InheritedScanState = {
        fromId, toId, dateStr,
        timestamp: Date.now(),
        pMin, pCap, pCapExt,
        nearDateWarning, allReinFV,
        nvStructuresFound: candidates.length,
        fvStructuresFound: fvCandidates.length,
        candidates: candidates.map(serializeCandidate),
        fvCandidates: fvCandidates.map(serializeCandidate),
        allVerified: [...allVerified],
        allExtendedCandidates: [...allExtendedCandidates],
        sharedStopPool: [...sharedStopPool],
        highScoreConfigs: [...highScoreConfigs],
        highScoreSeen: [...highScoreSeen],
        testedPairs: [...testedPairs],
      };
      try {
        await chrome.storage.session.set({ lastScanState: stateToSave });
        console.log(`[scan] Saved state to session storage (${sharedStopPool.length} pool stops, ${allVerified.length} verified)`);
      } catch (err) {
        // Non-fatal — "Score verbessern" just won't have accumulated state
        console.warn("[scan] Failed to persist lastScanState:", err);
      }
    }
    } // end else (fresh Phase 1+2)

    // --- Decision logic ---
    const scoringCfg = getConfig().scoring;
    const shouldAutoExtend = isExtended || bestScore < scoringCfg.min;
    const canExtend = bestScore < scoringCfg.ideal;

    if (shouldAutoExtend) {
      checkAborted(signal);
      scanData.extendedTriggered = true;
      scanData.extendedAuto = !isExtended;

      // Re-estimate total API-call budget for the extended phase. The
      // earlier `+ 15 extended scan buffer` was set before the Step-4
      // fill-up feature existed — now extended typically makes ~150
      // calls (30 for day-window scans + ~120 for the NV/FV candidate
      // verifies it now feeds into the pipeline). Without this update
      // the UI's remaining-time text would freeze near where Phase 2
      // left off, since the old estimate is already (nearly) maxed out.
      const scanCfg = getConfig().scan;
      const extCallBudget =
        scanCfg.extendedDays * 6 +                   // day-window scans
        scanCfg.maxCandidatesPerPass * 10 +          // Step-5 NV verify
        scanCfg.maxFvCandidates * 15;                // Step-6 FV (seed+main)
      pt.estimatedTotal = pt.callsDone + extCallBudget;

      sendProgress({
        phase: "extended_scanning" as ScanProgress["phase"],
        current: 0, total: 1,
        message: "Erweiterter Scan — suche weitere Verbindungen...",
      });

      const extScanResult = await runExtendedScan(
        fromId, toId, targetDate, candidates, fvCandidates,
        pMin, pCap, pCapExt, allExtendedCandidates,
        topZPairs,
        (p) => { checkAborted(signal); sendProgress(p); },
        signal,
        allExperiments,
        sharedStopPool,
        collectHighScore,
        () => { pt.callsDone++; },
        testedPairs
      );

      // Merge extended results and zPair updates
      zPairUpdates.push(...extScanResult.zPairUpdates);
      allVerified = deduplicateConfigs([...allVerified, ...extScanResult.configs]);
      allVerified.sort((a, b) => b.score - a.score);
      bestScore = allVerified.length > 0 ? allVerified[0].score : 0;

      // Fallback 1: if no result >=80% (FALLBACK_SCORE_MIN) under pCapExt,
      // include high-score configs over pCapExt (no upper price cap).
      if (bestScore < FALLBACK_SCORE_MIN && highScoreConfigs.length > 0) {
        const overCapHighScore = highScoreConfigs.filter(c =>
          !allVerified.some(v => `${v.totalPrice.toFixed(2)}-${(v.score * 1000).toFixed(0)}` === `${c.totalPrice.toFixed(2)}-${(c.score * 1000).toFixed(0)}`)
        );
        if (overCapHighScore.length > 0) {
          console.log(`[fallback] Adding ${overCapHighScore.length} high-score configs (>80%) that exceed pCapExt`);
          allVerified = deduplicateConfigs([...allVerified, ...overCapHighScore]);
          allVerified.sort((a, b) => b.score - a.score);
          bestScore = allVerified.length > 0 ? allVerified[0].score : 0;
        }
      }

      // Fallback 2: even if we have some >=80% results, if none of them
      // is >=90% (scoring.ideal), surface any 90%+ configs that were
      // found above pCapExt but below pCapMax (4× pMin). Rationale: a
      // 91% result at 3.5× pMin is more useful to show than a 82% at
      // pCap — the user can decide whether the extra cost is worth
      // the higher cancellation-probability score.
      const pCapMax = pMin * 4;
      const idealScore = getConfig().scoring.ideal;
      if (bestScore < idealScore && highScoreConfigs.length > 0) {
        const idealOverCap = highScoreConfigs.filter(c =>
          c.score >= idealScore &&
          c.totalPrice > pCapExt &&
          c.totalPrice <= pCapMax &&
          !allVerified.some(v => `${v.totalPrice.toFixed(2)}-${(v.score * 1000).toFixed(0)}` === `${c.totalPrice.toFixed(2)}-${(c.score * 1000).toFixed(0)}`)
        );
        if (idealOverCap.length > 0) {
          console.log(
            `[fallback] Adding ${idealOverCap.length} ideal-score configs (>=${(idealScore * 100).toFixed(0)}%) ` +
            `between pCapExt (${pCapExt.toFixed(2)}€) and pCapMax (${pCapMax.toFixed(2)}€)`
          );
          allVerified = deduplicateConfigs([...allVerified, ...idealOverCap]);
          allVerified.sort((a, b) => b.score - a.score);
          bestScore = allVerified.length > 0 ? allVerified[0].score : 0;
        }
      }

      const displayJourney = candidates[0]?.journey || (fvCandidates[0]?.journey ?? null);
      onResult(buildResult(
        displayJourney, dateStr, allVerified,
        pMin, pCap, bestScore,
        false, true, allReinFV && allVerified.length === 0, nearDateWarning, true
      ));
    } else if (canExtend && bestScore >= scoringCfg.min) {
      const displayJourney = candidates[0]?.journey || (fvCandidates[0]?.journey ?? null);
      onResult(buildResult(
        displayJourney, dateStr, allVerified,
        pMin, pCap, bestScore,
        true, false, false, nearDateWarning, false
      ));
    } else {
      const displayJourney = candidates[0]?.journey || (fvCandidates[0]?.journey ?? null);
      onResult(buildResult(
        displayJourney, dateStr, allVerified,
        pMin, pCap, bestScore,
        false, false, allReinFV && allVerified.length === 0, nearDateWarning, false
      ));
    }

    scanData.totalConfigs = allVerified.length;
    scanData.bestScore = bestScore;
    scanData.terminationReason = allVerified.length > 0
      ? "completed"
      : "no_results";

    sendProgress({
      phase: "done", current: 1, total: 1,
      message: `${allVerified.length} verifizierte Konfigurationen gefunden.`,
    });

  } catch (err) {
    scanData.errorMessage = err instanceof Error ? err.message : "Unbekannter Fehler";
    scanData.terminationReason = scanData.errorMessage === "cancelled"
      ? "user_cancelled"
      : "error";

    // Send partial results if we have any — better than nothing
    if (allVerified.length > 0) {
      const displayJourney = candidates[0]?.journey || (fvCandidates[0]?.journey ?? null);
      console.log(`[scan] Error with ${allVerified.length} partial results — sending to client`);
      onResult(buildResult(
        displayJourney, dateStr, allVerified,
        pMin, pCap, bestScore,
        false, false, false, nearDateWarning, false
      ));
      sendProgress({
        phase: "done", current: 1, total: 1,
        message: `${allVerified.length} Ergebnisse gefunden (Scan wurde vorzeitig beendet).`,
      });
    } else if (scanData.errorMessage !== "cancelled") {
      sendProgress({
        phase: "error", current: 0, total: 0,
        message: `Fehler: ${scanData.errorMessage}`,
      });
    }
  } finally {
    scanData.durationMs = Date.now() - scanStart;
    releaseConfig();
  }

  return { scanData, experiments: allExperiments, zPairUpdates };
}
