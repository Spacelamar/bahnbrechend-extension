/**
 * Remote config for tuning scan parameters without an extension update.
 *
 * Shape is strictly validated — any unknown or invalid value falls back to
 * DEFAULT_CONFIG. The server is never trusted to inject new fields or
 * arbitrary logic; this file enumerates every tunable.
 */

export interface ExtensionConfig {
  /** Schema version. Bump when adding/removing fields. */
  version: number;
  scoring: {
    /** Early-terminate threshold (hit is considered "ideal") */
    ideal: number;
    /** Minimum score for standard-scan hits */
    min: number;
    /** Minimum score for extended-scan hits */
    minExtended: number;
  };
  price: {
    /** pCap = pMin * capMultiplier. Standard ceiling. */
    capMultiplier: number;
    /** pCapExt = pMin * capExtMultiplier. Extended-scan ceiling. */
    capExtMultiplier: number;
    /** Early terminate when >=3 ideal configs AND one is <= pMin * this. */
    earlyTerminateMultiplier: number;
  };
  scan: {
    /** Days sampled in the standard scan */
    standardDays: number;
    /** Additional days sampled in the extended scan */
    extendedDays: number;
    /** Via-stop experiments generated per NV candidate */
    maxExperiments: number;
    /** FV-phase experiments per FV candidate */
    fvTargetExperiments: number;
    /** NV candidates verified per pass */
    maxCandidatesPerPass: number;
    /** Rein-FV candidates verified per pass */
    maxFvCandidates: number;
  };
  filters: {
    /** Skip offers that cover only part of the journey */
    skipTeilpreis: boolean;
    /** Skip journeys containing FlixTrain legs */
    skipFlixTrain: boolean;
  };
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  version: 1,
  scoring: { ideal: 0.9, min: 0.7, minExtended: 0.5 },
  price: {
    capMultiplier: 2.0,
    capExtMultiplier: 3.0,
    earlyTerminateMultiplier: 1.2,
  },
  scan: {
    standardDays: 10,
    extendedDays: 5,
    maxExperiments: 10,
    fvTargetExperiments: 8,
    maxCandidatesPerPass: 5,
    maxFvCandidates: 5,
  },
  filters: {
    skipTeilpreis: true,
    skipFlixTrain: true,
  },
};

const CONFIG_URL = "https://bahnbrechend.net/api/config";
const CONFIG_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

let currentConfig: ExtensionConfig = DEFAULT_CONFIG;
let lastFetchMs = 0;
let inFlight: Promise<void> | null = null;
let scanSnapshot: ExtensionConfig | null = null;

/**
 * Synchronous accessor. Returns the scan-time snapshot when a scan is in
 * progress (so all reads within one scan see the same config), otherwise
 * the most recently loaded config (or DEFAULT_CONFIG before first load).
 */
export function getConfig(): ExtensionConfig {
  return scanSnapshot ?? currentConfig;
}

/**
 * Freeze the config for the duration of a scan. Call at scan start; the
 * returned snapshot is what getConfig() will return until releaseConfig()
 * is called. Prevents a mid-scan loadConfig() refresh from changing
 * thresholds/filters between early and late results of the same scan.
 */
export function snapshotConfig(): ExtensionConfig {
  scanSnapshot = currentConfig;
  return scanSnapshot;
}

export function releaseConfig(): void {
  scanSnapshot = null;
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < min || v > max) return fallback;
  return v;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Validates raw server response against the schema. Every field is checked
 * for type and numeric range; invalid values silently fall back to the
 * defaults. Unknown top-level fields are ignored — there is no path by
 * which a server response can introduce new behavior, only change numbers
 * and booleans within the declared bounds.
 */
export function validateConfig(raw: unknown): ExtensionConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_CONFIG;
  const scoring = obj(r.scoring);
  const price = obj(r.price);
  const scan = obj(r.scan);
  const filters = obj(r.filters);

  return {
    version: num(r.version, d.version, 0, 1000),
    scoring: {
      ideal: num(scoring.ideal, d.scoring.ideal, 0, 1),
      min: num(scoring.min, d.scoring.min, 0, 1),
      minExtended: num(scoring.minExtended, d.scoring.minExtended, 0, 1),
    },
    price: {
      capMultiplier: num(price.capMultiplier, d.price.capMultiplier, 1, 10),
      capExtMultiplier: num(price.capExtMultiplier, d.price.capExtMultiplier, 1, 20),
      earlyTerminateMultiplier: num(
        price.earlyTerminateMultiplier,
        d.price.earlyTerminateMultiplier,
        1,
        10
      ),
    },
    scan: {
      standardDays: num(scan.standardDays, d.scan.standardDays, 1, 30),
      extendedDays: num(scan.extendedDays, d.scan.extendedDays, 0, 30),
      maxExperiments: num(scan.maxExperiments, d.scan.maxExperiments, 1, 100),
      fvTargetExperiments: num(
        scan.fvTargetExperiments,
        d.scan.fvTargetExperiments,
        1,
        100
      ),
      maxCandidatesPerPass: num(
        scan.maxCandidatesPerPass,
        d.scan.maxCandidatesPerPass,
        1,
        50
      ),
      maxFvCandidates: num(scan.maxFvCandidates, d.scan.maxFvCandidates, 0, 50),
    },
    filters: {
      skipTeilpreis: bool(filters.skipTeilpreis, d.filters.skipTeilpreis),
      skipFlixTrain: bool(filters.skipFlixTrain, d.filters.skipFlixTrain),
    },
  };
}

/**
 * Fetch fresh config from the server. Safe to call concurrently —
 * dedupes in-flight requests. Never throws; on any error keeps the
 * currently-held config (or defaults if nothing was ever fetched).
 *
 * Called opportunistically at scan start. Scans never wait on this —
 * if the fetch is slow or fails, the scan proceeds with whatever
 * config was last loaded (or defaults).
 */
export function loadConfig(force = false): Promise<void> {
  const now = Date.now();
  if (!force && lastFetchMs > 0 && now - lastFetchMs < CONFIG_TTL_MS) {
    return Promise.resolve();
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const res = await fetch(CONFIG_URL, {
        method: "GET",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const raw = await res.json();
      currentConfig = validateConfig(raw);
      lastFetchMs = Date.now();
      console.log(`[config] Loaded v${currentConfig.version}`);
    } catch (err) {
      const mode = lastFetchMs > 0 ? "cached" : "defaults";
      console.warn(`[config] Fetch failed, using ${mode}:`, err);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
