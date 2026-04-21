/**
 * Message protocol between web page ↔ content script ↔ background worker.
 *
 * All messages carry `source` (origin identifier) and `requestId` (correlation).
 */

import type { ScanProgress, OptimizeResult } from "./types";

// ============================================================
// Web → Extension messages
// ============================================================

export type WebMessageType = "ping" | "scan_start" | "scan_start_extended" | "scan_cancel";

export interface ZPairWinner {
  stop1: { id: string; name: string };
  stop2: { id: string; name: string };
  zScore: number;
}

export interface WebMessage {
  source: "bahnbrechend-web";
  requestId: string;
  type: WebMessageType;
  payload: ScanStartPayload | Record<string, never>;
}

export interface ScanStartPayload {
  fromId: string;
  toId: string;
  date: string;
  topZPairs: ZPairWinner[];
}

// ============================================================
// Extension → Web messages
// ============================================================

export type ExtMessageType = "pong" | "progress" | "result" | "error" | "scan_complete";

export interface ExtMessage {
  source: "bahnbrechend-ext";
  requestId: string;
  type: ExtMessageType;
  payload: unknown;
}

export interface PongPayload {
  version: string;
}

export interface ErrorPayload {
  message: string;
}

export interface ScanCompletePayload {
  scanData: Record<string, unknown>;
  experiments: Record<string, unknown>[];
  zPairUpdates: { routeKey: string; stop1Id: string; stop1Name: string; stop2Id: string; stop2Name: string; score: number; price: number }[];
}

// ============================================================
// Type guards
// ============================================================

export function isWebMessage(data: unknown): data is WebMessage {
  return typeof data === "object" && data !== null && (data as WebMessage).source === "bahnbrechend-web";
}

export function isExtMessage(data: unknown): data is ExtMessage {
  return typeof data === "object" && data !== null && (data as ExtMessage).source === "bahnbrechend-ext";
}
