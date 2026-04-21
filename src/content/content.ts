/**
 * Content script: bridges messages between bahnbrechend.net web page and extension background worker.
 * Injected on bahnbrechend.net and localhost:3000.
 */

import { isWebMessage, isExtMessage } from "../shared/protocol";

// Content scripts are only injected on the matches listed in manifest.json
// (bahnbrechend.net + localhost:3000), so window.location.origin is
// guaranteed to be one of those — use it as the explicit postMessage
// target to avoid leaking messages cross-origin.
const PAGE_ORIGIN = window.location.origin;

// Web Page → Background Worker
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== PAGE_ORIGIN) return;
  if (!isWebMessage(event.data)) return;
  chrome.runtime.sendMessage(event.data);
});

// Background Worker → Web Page — explicit origin (no wildcard) so that
// only the expected page receives ExtMessages.
chrome.runtime.onMessage.addListener((message) => {
  if (!isExtMessage(message)) return;
  window.postMessage(message, PAGE_ORIGIN);
});
