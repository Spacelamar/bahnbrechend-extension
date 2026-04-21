export interface Station {
  id: string;
  name: string;
}

export interface Leg {
  origin: Station;
  destination: Station;
  departure: string;
  arrival: string;
  line: {
    id: string;
    name: string;
    product: string;
  };
  /** Intermediate stops from bahn.de halte (optional, present when available) */
  halte?: { station: Station; arrival: string | null; departure: string | null }[];
}

export interface Journey {
  type: string;
  id: string;
  origin: Station;
  destination: Station;
  legs: Leg[];
  price: {
    currency: string;
    amount: number;
    discount: boolean;
    name: string;
  };
}

export interface Stopover {
  station: Station;
  arrival: string | null;
  departure: string | null;
  arrivalDelay: number | null;
  departureDelay: number | null;
}

export interface LegWithStopovers extends Leg {
  stopovers: Stopover[];
  tripId?: string;
}

// --- Scan progress ---

export interface ScanProgress {
  phase:
    | "scanning"
    | "fetching-stopovers"
    | "optimizing"
    | "verifying"
    | "extended_scanning"
    | "extended_verifying"
    | "done"
    | "error";
  current: number;
  total: number;
  message: string;
  subMessage?: string;
  /** Total API calls completed so far in this scan */
  apiCallsDone?: number;
  /** Estimated total API calls for this scan */
  apiCallsEstimatedTotal?: number;
}

// --- Phase 1 result types ---

export interface CandidateEntry {
  journey: Journey;
  stopovers: Map<number, import("./bahn-api").BahnStopover[]>;
  structuralKey: string;
  price: number;
}

export interface FVCandidateEntry {
  journey: Journey;
  stopovers: Map<number, import("./bahn-api").BahnStopover[]>;
  structuralKey: string;
  price: number;
}

export interface Phase1Result {
  candidates: CandidateEntry[];
  fvCandidates: FVCandidateEntry[];
  pMin: number;
  allReinFV: boolean;
  nearDateWarning: boolean;
  dayTimings: import("./bahn-api").DayScanTiming[];
}

// --- Phase 2 candidate (via-stop combination to test) ---

export interface ViaStopCandidate {
  viaStops: Station[];
  /** true when the pair came from the persistent route_zpairs cache */
  fromZPairCache?: boolean;
  /** zScore recorded in the cache at the moment this pair was picked */
  zpairPriorZscore?: number;
}

/**
 * Per-transfer detail used by the delay model AND logged to the DB for
 * retrospective zPair analysis — we want to correlate transfer counts
 * and durations with which stop-pairs produce them.
 */
export interface TransferDetail {
  min: number;
  incomingType: string;
  station: string;
}

// --- Legacy types kept for candidate generation ---

export interface ScoredConfig {
  viaStops: Station[];
  score: number;
  segments: SegmentInfo[];
  shortestTransfer: number;
}

export interface SegmentInfo {
  from: Station;
  to: Station;
  departure: string;
  arrival: string;
  transferMinutes: number | null;
  pMiss: number;
  trainType: string;
}

// --- Verified config (real API data) ---

export interface RealSegment {
  from: Station;
  to: Station;
  departure: string;
  arrival: string;
  trainName: string;
  transferMinutes: number | null;
  price: number;
  /** Intermediate stops from bahn.de halte */
  halte?: { station: Station; arrival: string | null; departure: string | null }[];
}

export interface VerifiedConfig {
  viaStops: Station[];
  score: number;
  realSegments: RealSegment[];
  totalPrice: number;
  originalPrice: number;
  shortestTransfer: number;
  sameTrains: boolean;
  /** Transfers of the modified (result) journey — input to pRouteFailure */
  transfers?: TransferDetail[];
  /** Transfers of the original, unmodified journey (for before/after analysis) */
  originalTransfers?: TransferDetail[];
}

// --- Optimize result (sent to UI) ---

export interface OptimizeResult {
  journey: Journey | null;
  date: string;
  configs: VerifiedConfig[];
  pMin: number;
  pCap: number;
  bestScore: number;
  extendedScanAvailable: boolean;
  extendedScanAutoStarted: boolean;
  allReinFV: boolean;
  nearDateWarning: boolean;
  isExtendedResult: boolean;
}

// --- SSE messages ---

export type SSEMessageType =
  | "progress"
  | "result"
  | "extended_scan_start"
  | "error"
  | "ping"
  | "scan_started";

export interface SSEMessage {
  type: SSEMessageType;
  data: ScanProgress | OptimizeResult | { message: string } | { queueId: string } | Record<string, never>;
}
