/**
 * Message dispatcher — routes incoming messages to the appropriate handler.
 *
 * Security notes:
 *  - All incoming messages pass `isValidWebMessage()` which checks the
 *    payload shape AND character sets (no `@` / `=` / newlines in IDs,
 *    date must match YYYY-MM-DD). A malformed or adversarial message
 *    is dropped silently.
 *  - Sender is verified to come from a whitelisted origin (bahnbrechend.net
 *    or localhost dev). Third-party pages that somehow reach this handler
 *    via a different content-script injection path are rejected.
 *  - Outgoing messages are scoped to the originating tab only — no more
 *    broadcasting scan results to every tab with our content script.
 */

import { isValidWebMessage, type WebMessage, type ExtMessage, type ScanStartPayload } from "../shared/protocol";
import { runScan, type InheritedScanState } from "./scan-engine";
import { routeKey } from "../shared/zpair-types";

// Hard ceiling on scan runtime — if bahn.de ever hangs, a well-behaved
// worker still aborts after this. Same checkAborted(signal) machinery
// inside scan-engine.ts then propagates the "cancelled" error upward.
//
// Bumped from 10 → 12 min in v1.2.7: inherited-extended scans (Berlin↔
// Hannover, Hamburg↔München) regularly hit 8-9 min after v1.2.6; 10 min
// left no margin for bahn.de slow days. 12 min is still strictly bounded.
const SCAN_TIMEOUT_MS = 12 * 60 * 1000;

// Max age of inherited state before we treat it as stale and fall back
// to a full rescan. 15 min matches typical user workflow: click scan,
// review results, click "Score verbessern" shortly after. Beyond that
// the underlying schedules/prices may have shifted.
const STATE_MAX_AGE_MS = 15 * 60 * 1000;

// Only content scripts injected into these hosts are allowed to drive
// the scan engine. MV3 matches already restrict the content script to
// these origins, but a belt-and-suspenders sender check protects against
// any future misconfiguration or injection path.
const ALLOWED_HOSTNAMES = new Set([
  "bahnbrechend.net",
  "www.bahnbrechend.net",
  "localhost",
  "127.0.0.1",
]);

let activeController: AbortController | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;

function clearScanTimeout() {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
}

/**
 * Send an ExtMessage to a specific tab. Replaces the old sendToWeb()
 * which broadcasted to every tab — that leaked scan results between
 * two bahnbrechend.net tabs in the same profile. Scoping to the tab
 * that initiated the scan closes that side-channel.
 */
function sendToTab(tabId: number, msg: ExtMessage) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/**
 * Verify a sender comes from a whitelisted origin. Returns null for
 * anything else so the caller can silently drop the message.
 */
function getAllowedHostname(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.tab || !sender.url) return null;
  try {
    const u = new URL(sender.url);
    return ALLOWED_HOSTNAMES.has(u.hostname) ? u.hostname : null;
  } catch {
    return null;
  }
}

export function handleMessage(message: unknown, sender: chrome.runtime.MessageSender) {
  // 1) Origin check: reject messages from non-whitelisted content scripts.
  if (!getAllowedHostname(sender)) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return; // no tab → nowhere to send responses

  // 2) Shape + character-set check on the payload itself.
  if (!isValidWebMessage(message)) return;
  const msg = message as WebMessage;

  switch (msg.type) {
    case "ping":
      // NOTE: we intentionally do NOT return the extension version here.
      // That turned out to be a fingerprinting primitive usable by any
      // embedded third-party script on bahnbrechend.net. The boolean
      // "is installed" signal that the pong message itself carries is
      // enough for the install-detection flow on the landing page.
      sendToTab(tabId, {
        source: "bahnbrechend-ext",
        requestId: msg.requestId,
        type: "pong",
        payload: { version: "ok" }, // opaque sentinel, matches old shape
      });
      break;

    case "scan_start":
    case "scan_start_extended": {
      // Cancel any running scan
      if (activeController) activeController.abort();
      clearScanTimeout();
      activeController = new AbortController();

      const payload = msg.payload as ScanStartPayload;
      const isExtended = msg.type === "scan_start_extended";
      const requestId = msg.requestId;
      const signal = activeController.signal;
      const originTabId = tabId; // captured for scoped responses

      activeTimeout = setTimeout(() => {
        console.warn(`[bahnbrechend] Scan exceeded ${SCAN_TIMEOUT_MS / 60000}min timeout, aborting`);
        if (activeController) activeController.abort();
      }, SCAN_TIMEOUT_MS);

      console.log(`[bahnbrechend] Scan ${isExtended ? "extended " : ""}start: ${payload.fromId} → ${payload.toId} (${payload.date})`);

      // For the manual "Score verbessern" click, try to reuse the state
      // from the previous scan on the same route. This lets the extended
      // scan skip Phase 1+2 and pick up with the already-accumulated
      // ~140-stop shared pool, the pMin/pCap values, existing verified
      // results, etc. — cutting ~5 min off the flow.
      const startScan = async () => {
        let inheritedState: InheritedScanState | undefined;
        if (isExtended) {
          try {
            const stored = await chrome.storage.session.get("lastScanState");
            const s = stored.lastScanState as InheritedScanState | undefined;
            if (s) {
              const routeMatch = s.fromId === payload.fromId && s.toId === payload.toId;
              const dateMatch = s.dateStr === payload.date;
              const age = Date.now() - s.timestamp;
              const fresh = age < STATE_MAX_AGE_MS;
              if (routeMatch && dateMatch && fresh) {
                inheritedState = s;
                console.log(`[bahnbrechend] Reusing state from ${Math.round(age / 1000)}s ago (${s.sharedStopPool.length} pool stops, ${s.allVerified.length} verified)`);
              } else {
                console.log(`[bahnbrechend] Skipping inherited state — routeMatch=${routeMatch} dateMatch=${dateMatch} fresh=${fresh} (age=${Math.round(age / 1000)}s)`);
                // Proactively clear stale state so it cannot leak into a
                // different route's future scan (defense in depth).
                if (!routeMatch || !dateMatch) {
                  chrome.storage.session.remove("lastScanState").catch(() => {});
                }
              }
            }
          } catch (err) {
            console.warn("[bahnbrechend] Failed to read lastScanState:", err);
          }
        }

        return runScan({
          fromId: payload.fromId,
          toId: payload.toId,
          date: payload.date,
          isExtended,
          topZPairs: payload.topZPairs as [],
          signal,
          onProgress: (progress) => {
            sendToTab(originTabId, {
              source: "bahnbrechend-ext",
              requestId,
              type: "progress",
              payload: progress,
            });
          },
          onResult: (result) => {
            sendToTab(originTabId, {
              source: "bahnbrechend-ext",
              requestId,
              type: "result",
              payload: result,
            });
          },
          inheritedState,
        });
      };

      startScan().then((analytics) => {
        sendToTab(originTabId, {
          source: "bahnbrechend-ext",
          requestId,
          type: "scan_complete",
          payload: {
            ...analytics,
            routeKey: routeKey(payload.fromId, payload.toId),
          },
        });
        activeController = null;
        clearScanTimeout();
      }).catch((err) => {
        if (err?.message === "cancelled") {
          console.log("[bahnbrechend] Scan cancelled");
        } else {
          console.error("[bahnbrechend] Scan error:", err);
          sendToTab(originTabId, {
            source: "bahnbrechend-ext",
            requestId,
            type: "error",
            payload: { message: err?.message || "Unbekannter Fehler" },
          });
        }
        activeController = null;
        clearScanTimeout();
      });
      break;
    }

    case "scan_cancel":
      if (activeController) {
        activeController.abort();
        activeController = null;
        clearScanTimeout();
        console.log("[bahnbrechend] Scan cancelled");
      }
      break;
  }
}
