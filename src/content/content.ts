/**
 * Content script: bridges messages between bahnbrechend.net web page and extension background worker.
 * Injected on bahnbrechend.net and localhost:3000.
 */

import { isWebMessage, isExtMessage } from "../shared/protocol";

// Web Page → Background Worker
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!isWebMessage(event.data)) return;
  chrome.runtime.sendMessage(event.data);
});

// Background Worker → Web Page
chrome.runtime.onMessage.addListener((message) => {
  if (!isExtMessage(message)) return;
  window.postMessage(message, "*");
});
