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

// ============================================================
// Strict payload validators — defense in depth
// ============================================================
//
// The `source === "bahnbrechend-web"` check alone is not enough: an
// attacker with any JS execution context on bahnbrechend.net (XSS,
// malicious third-party script) fully controls that string. Before any
// payload reaches `runScan` we validate shape + character set so that
// manipulated `fromId`/`toId`/`date`/`topZPairs` cannot be smuggled
// into bahn.de POST bodies as extra LID segments (`@`, `=` are
// parser-significant in the HAFAS LID format).

// Bahn.de station IDs are digits, occasionally prefixed ("A=1@..." etc.
// handled elsewhere). We accept word-safe ASCII plus `-` and `.` as a
// generous envelope. No `@`, `=`, `|`, `<`, `>`, quotes, newlines.
const STATION_ID_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const STATION_NAME_RE = /^[^\x00-\x1f@=|<>"`]{1,120}$/; // any non-control char except parser-specials
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_ID_RE = /^[a-zA-Z0-9-]{1,64}$/; // crypto.randomUUID shape

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidZPairWinner(v: unknown): v is ZPairWinner {
  if (!isPlainObject(v)) return false;
  const s1 = v.stop1 as Record<string, unknown> | undefined;
  const s2 = v.stop2 as Record<string, unknown> | undefined;
  if (!isPlainObject(s1) || !isPlainObject(s2)) return false;
  if (typeof s1.id !== "string" || !STATION_ID_RE.test(s1.id)) return false;
  if (typeof s1.name !== "string" || !STATION_NAME_RE.test(s1.name)) return false;
  if (typeof s2.id !== "string" || !STATION_ID_RE.test(s2.id)) return false;
  if (typeof s2.name !== "string" || !STATION_NAME_RE.test(s2.name)) return false;
  if (typeof v.zScore !== "number" || !Number.isFinite(v.zScore)) return false;
  if (v.zScore < 0 || v.zScore > 2) return false;
  return true;
}

function isValidScanStartPayload(p: unknown): p is ScanStartPayload {
  if (!isPlainObject(p)) return false;
  if (typeof p.fromId !== "string" || !STATION_ID_RE.test(p.fromId)) return false;
  if (typeof p.toId !== "string" || !STATION_ID_RE.test(p.toId)) return false;
  if (typeof p.date !== "string" || !DATE_RE.test(p.date)) return false;
  // Sanity check: date parses
  if (Number.isNaN(new Date(p.date + "T00:00:00Z").getTime())) return false;
  if (!Array.isArray(p.topZPairs)) return false;
  if (p.topZPairs.length > 50) return false; // generous — we only use top 5
  if (!p.topZPairs.every(isValidZPairWinner)) return false;
  return true;
}

/**
 * Strict validator for incoming web→ext messages. Call this instead of
 * (or in addition to) `isWebMessage` at every dispatch site where the
 * payload is about to be consumed. Rejects anything that doesn't match
 * the exact expected shape for the given message type.
 */
export function isValidWebMessage(data: unknown): data is WebMessage {
  if (!isWebMessage(data)) return false;
  const m = data as WebMessage;
  if (typeof m.requestId !== "string" || !REQUEST_ID_RE.test(m.requestId)) return false;
  if (typeof m.type !== "string") return false;

  switch (m.type) {
    case "ping":
    case "scan_cancel":
      // Payload must be a plain object (possibly empty). No fields required.
      return isPlainObject(m.payload);
    case "scan_start":
    case "scan_start_extended":
      return isValidScanStartPayload(m.payload);
    default:
      return false;
  }
}
