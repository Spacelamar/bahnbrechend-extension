/**
 * Message dispatcher — routes incoming messages to the appropriate handler.
 */

import { isWebMessage, type WebMessage, type ExtMessage, type ScanStartPayload } from "../shared/protocol";
import { runScan } from "./scan-engine";
import { routeKey } from "../shared/zpair-types";

const VERSION = chrome.runtime.getManifest().version;
let activeController: AbortController | null = null;

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
      activeController = new AbortController();

      const payload = msg.payload as ScanStartPayload;
      const isExtended = msg.type === "scan_start_extended";
      const requestId = msg.requestId;
      const signal = activeController.signal;

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
      });
      break;
    }

    case "scan_cancel":
      if (activeController) {
        activeController.abort();
        activeController = null;
        console.log("[bahnbrechend] Scan cancelled");
      }
      break;
  }
}
