/**
 * Message dispatcher — routes incoming messages to the appropriate handler.
 */

import { isWebMessage, type WebMessage, type ExtMessage, type ScanStartPayload } from "../shared/protocol";
import { runScan } from "./scan-engine";
import { routeKey } from "../shared/zpair-types";

const VERSION = chrome.runtime.getManifest().version;
// Hard ceiling on scan runtime — if bahn.de ever hangs, a well-behaved
// worker still aborts after this. Same checkAborted(signal) machinery
// inside scan-engine.ts then propagates the "cancelled" error upward.
const SCAN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
let activeController: AbortController | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;

function clearScanTimeout() {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
}

function sendToWeb(msg: ExtMessage) {
  // Send to ALL tabs that might have our content script
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    }
  });
}

export function handleMessage(message: unknown, _sender: chrome.runtime.MessageSender) {
  if (!isWebMessage(message)) return;
  const msg = message as WebMessage;

  switch (msg.type) {
    case "ping":
      sendToWeb({
        source: "bahnbrechend-ext",
        requestId: msg.requestId,
        type: "pong",
        payload: { version: VERSION },
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

      // Safety timeout: if bahn.de is unreachable/hanging and the scan
      // would otherwise run forever, abort after 10 minutes. The scan
      // engine's checkAborted(signal) reports this as a normal cancel.
      activeTimeout = setTimeout(() => {
        console.warn("[bahnbrechend] Scan exceeded 10min timeout, aborting");
        if (activeController) activeController.abort();
      }, SCAN_TIMEOUT_MS);

      console.log(`[bahnbrechend] Scan ${isExtended ? "extended " : ""}start: ${payload.fromId} → ${payload.toId} (${payload.date})`);

      // Run scan asynchronously
      runScan({
        fromId: payload.fromId,
        toId: payload.toId,
        date: payload.date,
        isExtended,
        topZPairs: payload.topZPairs as [],
        signal,
        onProgress: (progress) => {
          sendToWeb({
            source: "bahnbrechend-ext",
            requestId,
            type: "progress",
            payload: progress,
          });
        },
        onResult: (result) => {
          sendToWeb({
            source: "bahnbrechend-ext",
            requestId,
            type: "result",
            payload: result,
          });
        },
      }).then((analytics) => {
        // Send analytics data to web page (which POSTs to API)
        sendToWeb({
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
          sendToWeb({
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
