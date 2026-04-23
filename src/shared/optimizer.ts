import {
  LegWithStopovers,
  Station,
  Stopover,
  RealSegment,
  VerifiedConfig,
  ViaStopCandidate,
  Journey,
  TransferDetail,
} from "./types";
import { pRouteFailure } from "./delay-model";
import { searchJourneysWithVia, hasFernverkehr, hasFlixTrain, isFernverkehrLeg } from "./bahn-api";
import type { ZPair } from "./zpair-types";
import { getConfig } from "./config";

// ExperimentLog type (inlined to avoid DB dependency from scan-logger).
// `phase` and `candidateIndex` are set by enrichExperimentLogs in
// scan-engine.ts, so they're optional here.
export interface ExperimentLog {
  phase?: string;
  candidateIndex?: number;
  experimentIndex: number;
  viaStops: { id: string; name: string }[];
  outcome: string;
  resultScore?: number;
  resultPrice?: number;
  resultShortestTransfer?: number;
  /** Per-transfer detail for retrospective score analysis */
  resultTransfers?: TransferDetail[];
  resultTransferCount?: number;
  /** Transfers of the unmodified journey — baseline for "did fragmentation improve?" */
  originalTransfers?: TransferDetail[];
  originalTransferCount?: number;
  resultSameTrains?: boolean;
  resultLegCount?: number;
  resultTrainNames?: string[];
  durationMs: number;
  retried?: boolean;
  aufenthaltsdauer?: number;
  // FV-phase only (set in verifyFVWithStops)
  fvConnectionIndex?: number;
  isWinner?: boolean;
  /** Did the stop pair come from the persistent zPair cache (vs random)? */
  fromZPairCache?: boolean;
  /** Cached zScore at the moment the pair was selected */
  zpairPriorZscore?: number;
}

// Score thresholds & experiment counts now live in the remote config
// (see shared/config.ts). Call getConfig().scoring.* at every usage site.

// ============================================================
// STEP 1: Generate random NV-focused via-stop experiments
// ============================================================

/**
 * Generate via-stop experiments for a journey.
 *
 * Uses a two-tier approach:
 * 1. Winners: Top zPairs from the persistent route pool (if available)
 * 2. Random: Fill remaining slots from the connection's stop pool
 *
 * Total: always MAX_EXPERIMENTS (10).
 * Winners + Random = 10. If 3 winners, 7 random. If 0 winners, 10 random.
 *
 * @param stopPool - All available stops for random zPair generation
 *   NV connections: NV-leg stopovers
 *   FV connections: FV-leg stopovers (intermediate station stops)
 * @param topZPairs - Persistent route-level winners (zScore ≥ 50%)
 */
export function generateCandidateConfigs(
  stopPool: Station[],
  topZPairs: ZPair[] = [],
  fromId?: string,
  toId?: string,
  alreadyTestedPairs?: Set<string>
): ViaStopCandidate[] {
  // Carry provenance (cache-hit + prior zScore) alongside each pair so
  // the ExperimentLog can record whether a hit came from the zPair cache
  // or from random exploration.
  const experiments: {
    stops: Station[];
    fromCache: boolean;
    priorZscore?: number;
  }[] = [];
  // `seen` tracks dedup WITHIN this call. `alreadyTestedPairs` (optional)
  // tracks dedup ACROSS the whole scan — same pair tested in a previous
  // candidate/phase won't be sent to the API again. Both use the same
  // order-sensitive `id,id` key format.
  const seen = new Set<string>();
  const scanDedup = alreadyTestedPairs; // readability alias

  // Validate a pair: origin never as 1st stop, destination never as any stop
  const isValidPair = (stops: Station[]): boolean => {
    if (stops.length < 2) return true;
    if (fromId && stops[0].id === fromId) return false; // origin as 1st stop = nonsensical
    if (toId && stops.some(s => s.id === toId)) return false; // destination as any stop = nonsensical
    return true;
  };

  let skippedAlreadyTested = 0;

  // Dedup-Key: order-insensitive für 2-Stop-Paare. bahn.de sortiert
  // `zwischenhalte` intern geografisch — die Reihenfolge in unserem
  // POST-Body hat keinen Einfluss auf die Antwort. Order-free Key
  // verhindert dass wir [A,B] und [B,A] als zwei separate Calls feuern.
  // Für 1-Stop-Paare ist der Key trivial gleich.
  const pairKey = (stops: Station[]): string =>
    stops.length === 2
      ? [stops[0].id, stops[1].id].sort().join(",")
      : stops.map((s) => s.id).join(",");

  // Tier 1: Winners from persistent pool
  for (const zp of topZPairs) {
    const pair = [zp.stop1, zp.stop2];
    if (!isValidPair(pair)) continue;
    const key = pairKey(pair);
    if (seen.has(key)) continue;
    if (scanDedup?.has(key)) { skippedAlreadyTested++; continue; }
    seen.add(key);
    scanDedup?.add(key);
    experiments.push({ stops: pair, fromCache: true, priorZscore: zp.zScore });
  }

  const numWinners = experiments.length;

  // Tier 2: Random from connection stop pool
  if (stopPool.length >= 2) {
    const maxExperiments = getConfig().scan.maxExperiments;
    // Bei Dedup brauchen wir eventuell mehr Attempts — das Set kann
    // viele Kandidaten rausfiltern. Doppelter Loop-Headroom reicht
    // praktisch (unique-Raum wächst quadratisch mit pool size).
    const attemptBudget = maxExperiments * (scanDedup ? 20 : 10);
    for (let attempt = 0; attempt < attemptBudget && experiments.length < maxExperiments; attempt++) {
      const pair = pick2Random(stopPool);
      if (!pair) break;
      if (!isValidPair(pair)) continue;
      const key = pairKey(pair);
      if (seen.has(key)) continue;
      if (scanDedup?.has(key)) { skippedAlreadyTested++; continue; }
      seen.add(key);
      scanDedup?.add(key);
      experiments.push({ stops: pair, fromCache: false });
    }
  } else if (stopPool.length === 1) {
    const key = pairKey(stopPool);
    if (!seen.has(key) && !scanDedup?.has(key)) {
      seen.add(key);
      scanDedup?.add(key);
      experiments.push({ stops: [stopPool[0]], fromCache: false });
    }
  }

  const dedupNote = skippedAlreadyTested > 0 ? ` [dedup skipped ${skippedAlreadyTested}]` : "";
  console.log(`[generateCandidates] ${experiments.length} experiments (${numWinners} winners + ${experiments.length - numWinners} random from ${stopPool.length} stops)${dedupNote}`);

  return experiments.map((e) => ({
    viaStops: e.stops,
    fromZPairCache: e.fromCache,
    zpairPriorZscore: e.priorZscore,
  }));
}

/**
 * Build a flat stop pool from NV-leg stopovers of a journey.
 * Used for NV-haltige connections.
 */
export function buildNVStopPool(legs: LegWithStopovers[]): Station[] {
  const pool: Station[] = [];
  const seen = new Set<string>();

  for (const leg of legs) {
    if (isFernverkehrLeg(leg)) continue;
    const stops = getIntermediateStops(leg);
    for (const stop of stops) {
      if (!seen.has(stop.id)) {
        seen.add(stop.id);
        pool.push(stop);
      }
    }
  }

  return pool;
}

// ============================================================
// STEP 2: Verify candidates via bahn.de API
// ============================================================

export interface VerifyOptions {
  originalPrice: number;
  pMin: number;
  pCap: number;
  pCapExt: number;
}

export interface VerifyResult {
  standard: VerifiedConfig[];
  extendedCandidates: VerifiedConfig[];
  /** All configs that had transfers, regardless of price (for stop pool enrichment) */
  allWithTransfers: VerifiedConfig[];
  experimentLogs: ExperimentLog[];
}



// --- Single-attempt verify helper (used for retry with different aufenthaltsdauer) ---

interface TryVerifyResult {
  outcome: string;
  durationMs: number;
  price: number;
  verified: VerifiedConfig | null;
  legCount: number;
  trainNames: string[];
  retried?: boolean;
}

async function tryVerify(
  fromId: string,
  toId: string,
  candidate: ViaStopCandidate,
  departure: string,
  originalJourney: Journey,
  opts: VerifyOptions,
  aufenthaltsdauer: number
): Promise<TryVerifyResult> {
  const startMs = Date.now();
  const journeys = await searchJourneysWithVia(fromId, toId, candidate.viaStops, departure, aufenthaltsdauer);
  const durationMs = Date.now() - startMs;

  if (journeys.length === 0) {
    return { outcome: "no_results", durationMs, price: 0, verified: null, legCount: 0, trainNames: [] };
  }

  const targetDep = new Date(departure).getTime();
  let bestJourney = journeys[0];
  let bestDiff = Infinity;
  for (const j of journeys) {
    const diff = Math.abs(new Date(j.legs[0]?.departure || "").getTime() - targetDep);
    if (diff < bestDiff) { bestDiff = diff; bestJourney = j; }
  }

  if (getConfig().filters.skipFlixTrain && hasFlixTrain(bestJourney)) {
    return { outcome: "flixtrain", durationMs, price: 0, verified: null, legCount: 0, trainNames: [] };
  }
  if (!hasFernverkehr(bestJourney)) {
    return { outcome: "no_fv", durationMs, price: 0, verified: null, legCount: 0, trainNames: [] };
  }

  const resultPrice = bestJourney.price.amount;
  if (!resultPrice || resultPrice <= 0) {
    return { outcome: "no_price", durationMs, price: 0, verified: null, legCount: 0, trainNames: [] };
  }

  const verified = buildVerifiedFromJourney(candidate, bestJourney, originalJourney);
  if (!verified) {
    return { outcome: "no_transfers", durationMs, price: resultPrice, verified: null, legCount: bestJourney.legs.length, trainNames: bestJourney.legs.map(l => l.line.name) };
  }

  const retried = aufenthaltsdauer > 2;
  let outcome: string;
  if (resultPrice <= opts.pCap) {
    outcome = "hit_standard";
  } else if (resultPrice <= opts.pCapExt && verified.score >= getConfig().scoring.minExtended) {
    outcome = "hit_extended";
  } else {
    outcome = "too_expensive";
  }

  return {
    outcome, durationMs, price: resultPrice, verified,
    legCount: bestJourney.legs.length,
    trainNames: bestJourney.legs.map(l => l.line.name),
    retried,
  };
}

export async function verifyConfigs(
  candidates: ViaStopCandidate[],
  originalJourney: Journey,
  opts: VerifyOptions,
  onProgress?: (current: number, total: number) => void
): Promise<VerifyResult> {
  const standard: VerifiedConfig[] = [];
  const extendedCandidates: VerifiedConfig[] = [];
  const allWithTransfers: VerifiedConfig[] = [];
  const experimentLogs: ExperimentLog[] = [];

  const fromId = originalJourney.origin.id;
  const toId = originalJourney.destination.id;
  const departure = originalJourney.legs[0]?.departure;

  if (!departure) return { standard: [], extendedCandidates: [], allWithTransfers: [], experimentLogs: [] };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    onProgress?.(i + 1, candidates.length);

    const logEntry: ExperimentLog = {
      experimentIndex: i,
      viaStops: candidate.viaStops.map((s) => ({ id: s.id, name: s.name })),
      outcome: "error",
      durationMs: 0,
      fromZPairCache: candidate.fromZPairCache,
      zpairPriorZscore: candidate.zpairPriorZscore,
    };

    const viaNames = candidate.viaStops.map((s) => s.name).join(" + ");

    try {
      const result = await tryVerify(fromId, toId, candidate, departure, originalJourney, opts, 2);

      logEntry.durationMs = result.durationMs;

      // On no_transfers, retry with aufenthaltsdauer=5 (FV trains may ignore short stops)
      if (result.outcome === "no_transfers") {
        console.log(`[verify] ${i + 1}/${candidates.length} [${viaNames}] → no_transfers (${result.price}€), retrying with 5min stop...`);
        const retry = await tryVerify(fromId, toId, candidate, departure, originalJourney, opts, 5);
        logEntry.durationMs += retry.durationMs;
        logEntry.retried = true;

        if (retry.outcome === "no_transfers" || retry.outcome === "no_results" || retry.outcome === "no_price" || retry.outcome === "flixtrain" || retry.outcome === "no_fv") {
          logEntry.outcome = "no_transfers";
          logEntry.aufenthaltsdauer = 5;
          console.log(`[verify] ${i + 1}/${candidates.length} [${viaNames}] → retry also ${retry.outcome}`);
          experimentLogs.push(logEntry);
          continue;
        }
        // Use retry result
        Object.assign(result, retry);
        logEntry.aufenthaltsdauer = 5;
      } else {
        logEntry.retried = false;
        logEntry.aufenthaltsdauer = 2;
      }

      if (result.outcome === "no_results" || result.outcome === "no_price" || result.outcome === "flixtrain" || result.outcome === "no_fv") {
        logEntry.outcome = result.outcome;
        console.log(`[verify] ${i + 1}/${candidates.length} [${viaNames}] → ${result.outcome}`);
        experimentLogs.push(logEntry);
        continue;
      }

      if (!result.verified) {
        logEntry.outcome = result.outcome;
        experimentLogs.push(logEntry);
        continue;
      }

      // All verified configs (including too_expensive) go into allWithTransfers for pool enrichment
      allWithTransfers.push(result.verified);

      // Fill result details on log entry
      logEntry.resultPrice = result.price;
      logEntry.resultScore = result.verified.score;
      logEntry.resultShortestTransfer = result.verified.shortestTransfer;
      logEntry.resultTransfers = result.verified.transfers;
      logEntry.resultTransferCount = result.verified.transfers?.length;
      logEntry.originalTransfers = result.verified.originalTransfers;
      logEntry.originalTransferCount = result.verified.originalTransfers?.length;
      logEntry.resultSameTrains = result.verified.sameTrains;
      logEntry.resultLegCount = result.legCount;
      logEntry.resultTrainNames = result.trainNames;

      if (result.outcome === "hit_standard") {
        logEntry.outcome = "hit_standard";
        standard.push(result.verified);
        console.log(`[verify] ${i + 1}/${candidates.length} [${viaNames}] → ✓ HIT ${result.price}€ score=${(result.verified.score * 100).toFixed(0)}%${result.retried ? " (5min retry)" : ""}`);
      } else if (result.outcome === "hit_extended") {
        logEntry.outcome = "hit_extended";
        extendedCandidates.push(result.verified);
        console.log(`[verify] ${i + 1}/${candidates.length} [${viaNames}] → ✓ HIT_EXT ${result.price}€ score=${(result.verified.score * 100).toFixed(0)}%${result.retried ? " (5min retry)" : ""}`);
      } else {
        logEntry.outcome = "too_expensive";
        console.log(`[verify] ${i + 1}/${candidates.length} [${viaNames}] → too_expensive ${result.price}€ (pCap=${opts.pCap}€) score=${(result.verified.score * 100).toFixed(0)}%`);
      }
      experimentLogs.push(logEntry);
    } catch (err) {
      logEntry.outcome = "error";
      experimentLogs.push(logEntry);
      console.error(`[verify] ${i + 1}/${candidates.length} [${viaNames}] → ERROR:`, err);
    }
  }

  standard.sort((a, b) => b.score - a.score);
  extendedCandidates.sort((a, b) => b.score - a.score);

  return { standard, extendedCandidates, allWithTransfers, experimentLogs };
}

// ============================================================
// Build VerifiedConfig from real API journey
// ============================================================

/** Extract transfer list from a journey — same rule as the delay model
 *  (skip same-train artifacts, skip negative gaps). Used for both the
 *  result journey and the original baseline. */
function extractTransfers(journey: Journey): TransferDetail[] {
  const transfers: TransferDetail[] = [];
  for (let i = 1; i < journey.legs.length; i++) {
    const prevLeg = journey.legs[i - 1];
    const leg = journey.legs[i];
    const min = (new Date(leg.departure).getTime() - new Date(prevLeg.arrival).getTime()) / 60000;
    if (min < 0) continue;
    if (prevLeg.line.name === leg.line.name) continue; // same-train artifact
    transfers.push({
      min,
      incomingType: prevLeg.line.product || "regional",
      station: leg.origin.name,
    });
  }
  return transfers;
}

function buildVerifiedFromJourney(
  candidate: ViaStopCandidate,
  journey: Journey,
  originalJourney: Journey
): VerifiedConfig | null {
  const realSegments: RealSegment[] = [];
  // Scoring input: {transferMinutes, incomingTrainType, stationName}
  const scoringTransfers: { transferMinutes: number; incomingTrainType: string; stationName?: string }[] = [];
  // Same info but with the DB-friendly shape (TransferDetail)
  const transfers: TransferDetail[] = [];

  for (let i = 0; i < journey.legs.length; i++) {
    const leg = journey.legs[i];
    let transferMinutes: number | null = null;

    if (i > 0) {
      const prevLeg = journey.legs[i - 1];
      const prevArr = new Date(prevLeg.arrival).getTime();
      const currDep = new Date(leg.departure).getTime();
      transferMinutes = (currDep - prevArr) / 60000;

      if (transferMinutes >= 0) {
        // Same-train artifact: don't count as real transfer
        if (prevLeg.line.name !== leg.line.name) {
          const incomingType = prevLeg.line.product || "regional";
          scoringTransfers.push({
            transferMinutes,
            incomingTrainType: incomingType,
            stationName: leg.origin.name,
          });
          transfers.push({
            min: transferMinutes,
            incomingType,
            station: leg.origin.name,
          });
        }
      }
    }

    realSegments.push({
      from: leg.origin,
      to: leg.destination,
      departure: leg.departure,
      arrival: leg.arrival,
      trainName: leg.line.name,
      transferMinutes,
      price: 0,
      halte: leg.halte,
    });
  }

  if (realSegments.length === 0 || transfers.length === 0) return null;

  const score = pRouteFailure(scoringTransfers);
  const shortestTransfer = Math.min(...transfers.map((t) => t.min));

  const originalTrainNames = new Set(originalJourney.legs.map((l) => l.line.name));
  const sameTrains = journey.legs.every((l) => originalTrainNames.has(l.line.name));

  return {
    viaStops: candidate.viaStops,
    score,
    realSegments,
    totalPrice: journey.price.amount,
    originalPrice: originalJourney.price.amount,
    shortestTransfer,
    sameTrains,
    transfers,
    originalTransfers: extractTransfers(originalJourney),
  };
}

// ============================================================
// Helpers
// ============================================================

function getIntermediateStops(leg: LegWithStopovers): Station[] {
  if (!leg.stopovers || leg.stopovers.length < 2) return [];

  const originIdx = findStopIndex(leg.stopovers, leg.origin);
  const destIdx = findStopIndex(leg.stopovers, leg.destination);

  if (originIdx === -1 || destIdx === -1 || destIdx <= originIdx + 1) {
    console.log(`[getIntermediateStops] ${leg.line.name} (${leg.origin.name} → ${leg.destination.name}): originIdx=${originIdx}, destIdx=${destIdx}`);
    return [];
  }

  return leg.stopovers
    .slice(originIdx + 1, destIdx)
    .filter((s) => s.arrival && s.departure)
    .map((s) => s.station);
}

function findStopIndex(stopovers: Stopover[], station: Station): number {
  const exact = stopovers.findIndex((s) => s.station.id === station.id);
  if (exact !== -1) return exact;

  const last5 = station.id.slice(-5);
  const normalized = stopovers.findIndex((s) => s.station.id.slice(-5) === last5);
  if (normalized !== -1) return normalized;

  const nameLower = station.name.toLowerCase().trim();
  const byName = stopovers.findIndex((s) => s.station.name.toLowerCase().trim() === nameLower);
  if (byName !== -1) return byName;

  return -1;
}

function pick2Random<T>(arr: T[]): [T, T] | null {
  if (arr.length < 2) return null;
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

// ============================================================
// Phase 3: Verify pure FV journeys with stops from NV+FV pool
// ============================================================

/**
 * Test via-stop combinations on pure FV connections.
 * Uses stops collected from NV+FV optimization results.
 *
 * Strategy:
 * 1. First test "winner" configs from Phase 2 (score >= 70%, or top 3 if none)
 * 2. Then test 10 random 2-stop combos from the full stop pool
 */
export async function verifyFVWithStops(
  fvJourneys: { journey: Journey; price: number }[],
  winnerStops: Station[][],
  stopPool: Station[],
  opts: VerifyOptions,
  onProgress?: (current: number, total: number) => void,
  shouldStop?: (currentResults: VerifiedConfig[]) => boolean
): Promise<VerifyResult> {
  const standard: VerifiedConfig[] = [];
  const extendedCandidates: VerifiedConfig[] = [];
  const allWithTransfers: VerifiedConfig[] = [];
  const experimentLogs: ExperimentLog[] = [];

  if (stopPool.length < 2 && winnerStops.length === 0) {
    return { standard, extendedCandidates, allWithTransfers, experimentLogs };
  }

  const fvTargetExperiments = getConfig().scan.fvTargetExperiments;
  // Build experiment list: winners first, then fill with random combos
  const experiments: Station[][] = [...winnerStops.slice(0, fvTargetExperiments)];
  const numWinners = experiments.length;

  const winnerKeys = new Set(winnerStops.map((w) => w.map((s) => s.id).sort().join(",")));
  for (let i = 0; i < 50 && experiments.length < fvTargetExperiments; i++) {
    const combo = pick2Random(stopPool);
    if (!combo) break;
    const key = combo.map((s) => s.id).sort().join(",");
    if (winnerKeys.has(key)) continue;
    winnerKeys.add(key);
    experiments.push(combo);
  }

  console.log(`[verifyFV] Testing ${experiments.length} via-stop combos (${numWinners} winners + ${experiments.length - numWinners} random) on ${fvJourneys.length} FV connection(s)`);

  let step = 0;
  const totalSteps = fvJourneys.length * experiments.length;
  let stopped = false;

  for (let fvIdx = 0; fvIdx < fvJourneys.length; fvIdx++) {
    if (stopped) break;
    const fvEntry = fvJourneys[fvIdx];

    const fromId = fvEntry.journey.origin.id;
    const toId = fvEntry.journey.destination.id;
    const departure = fvEntry.journey.legs[0]?.departure;
    if (!departure) continue;

    for (let expIdx = 0; expIdx < experiments.length; expIdx++) {
      const viaStops = experiments[expIdx];
      step++;
      onProgress?.(step, totalSteps);

      const isWinner = expIdx < numWinners;
      const viaNames = viaStops.map((s) => s.name).join(" + ");
      const logEntry: ExperimentLog = {
        experimentIndex: expIdx,
        viaStops: viaStops.map((s) => ({ id: s.id, name: s.name })),
        outcome: "error",
        durationMs: 0,
        fvConnectionIndex: fvIdx,
        isWinner,
        // FV winners come from the winnerStops array (produced by Phase 2
        // results), so they're "cache hits" in the sense that they proved
        // themselves in this scan — not from the persistent route pool.
        fromZPairCache: isWinner,
      };

      const candidate: ViaStopCandidate = { viaStops };
      const prefix = `[verifyFV] FV${fvIdx + 1} ${step}/${totalSteps}`;

      try {
        const result = await tryVerify(fromId, toId, candidate, departure, fvEntry.journey, opts, 2);
        logEntry.durationMs = result.durationMs;

        // On no_transfers, retry with aufenthaltsdauer=5
        if (result.outcome === "no_transfers") {
          console.log(`${prefix} [${viaNames}] → no_transfers (${result.price}€), retrying with 5min stop...`);
          const retry = await tryVerify(fromId, toId, candidate, departure, fvEntry.journey, opts, 5);
          logEntry.durationMs += retry.durationMs;
          logEntry.retried = true;

          if (retry.outcome === "no_transfers" || retry.outcome === "no_results" || retry.outcome === "no_price" || retry.outcome === "flixtrain" || retry.outcome === "no_fv") {
            logEntry.outcome = "no_transfers";
            logEntry.aufenthaltsdauer = 5;
            console.log(`${prefix} [${viaNames}] → retry also ${retry.outcome}`);
            experimentLogs.push(logEntry);
            continue;
          }
          Object.assign(result, retry);
          logEntry.aufenthaltsdauer = 5;
        } else {
          logEntry.retried = false;
          logEntry.aufenthaltsdauer = 2;
        }

        if (result.outcome === "no_results" || result.outcome === "no_price" || result.outcome === "flixtrain" || result.outcome === "no_fv") {
          logEntry.outcome = result.outcome;
          console.log(`${prefix} [${viaNames}] → ${result.outcome}`);
          experimentLogs.push(logEntry);
          continue;
        }

        if (!result.verified) {
          logEntry.outcome = result.outcome;
          experimentLogs.push(logEntry);
          continue;
        }

        // All verified configs (including too_expensive) for pool enrichment
        allWithTransfers.push(result.verified);

        logEntry.resultPrice = result.price;
        logEntry.resultScore = result.verified.score;
        logEntry.resultShortestTransfer = result.verified.shortestTransfer;
        logEntry.resultTransfers = result.verified.transfers;
        logEntry.resultTransferCount = result.verified.transfers?.length;
        logEntry.originalTransfers = result.verified.originalTransfers;
        logEntry.originalTransferCount = result.verified.originalTransfers?.length;
        logEntry.resultSameTrains = result.verified.sameTrains;
        logEntry.resultLegCount = result.legCount;
        logEntry.resultTrainNames = result.trainNames;

        if (result.outcome === "hit_standard") {
          logEntry.outcome = "hit_standard";
          standard.push(result.verified);
          console.log(`${prefix} [${viaNames}] → ✓ HIT ${result.price}€ score=${(result.verified.score * 100).toFixed(0)}%${result.retried ? " (5min retry)" : ""}`);
        } else if (result.outcome === "hit_extended") {
          logEntry.outcome = "hit_extended";
          extendedCandidates.push(result.verified);
          console.log(`${prefix} [${viaNames}] → ✓ HIT_EXT ${result.price}€ score=${(result.verified.score * 100).toFixed(0)}%${result.retried ? " (5min retry)" : ""}`);
        } else {
          logEntry.outcome = "too_expensive";
          console.log(`${prefix} [${viaNames}] → too_expensive ${result.price}€ score=${(result.verified.score * 100).toFixed(0)}%`);
        }
        experimentLogs.push(logEntry);
      } catch (err) {
        logEntry.outcome = "error";
        experimentLogs.push(logEntry);
        console.error(`${prefix} [${viaNames}] → ERROR:`, err);
      }
    }

    // Check early termination after each FV candidate
    if (shouldStop?.(standard)) {
      console.log(`[verifyFV] Early termination triggered after ${step}/${totalSteps} steps`);
      stopped = true;
    }
  }

  standard.sort((a, b) => b.score - a.score);
  extendedCandidates.sort((a, b) => b.score - a.score);

  return { standard, extendedCandidates, allWithTransfers, experimentLogs };
}
