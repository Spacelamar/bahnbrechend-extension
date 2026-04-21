/**
 * zPair types and scoring for the extension.
 * DB persistence stays on the web side.
 */

import type { Station } from "./types";

export interface ZPair {
  stop1: Station;
  stop2: Station;
  zScore: number;
  experimentCount: number;
}

export interface ZPairUpdate {
  stop1: Station;
  stop2: Station;
  zScore: number;
}

export function routeKey(fromId: string, toId: string): string {
  return `${fromId}→${toId}`;
}

/**
 * Calculate zScore for a single experiment result.
 * zScore = score * priceWeight
 * priceWeight = max(0, 1 - (resultPrice - pMin) / (pCapExt - pMin))
 */
export function calculateZScore(
  score: number,
  resultPrice: number,
  pMin: number,
  pCapExt: number
): number {
  if (resultPrice <= 0 || pCapExt <= pMin) return 0;
  if (resultPrice > pCapExt) return 0;
  const priceWeight = Math.max(0, 1 - (resultPrice - pMin) / (pCapExt - pMin));
  return score * priceWeight;
}
