/**
 * Background service worker — entry point.
 * Receives messages from content script, dispatches to scan engine.
 */

import { handleMessage } from "./message-handler";
import { loadConfig } from "../shared/config";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender);
  // Return false — we send responses asynchronously via chrome.runtime.sendMessage
  return false;
});

// Kick off config fetch at SW start. Scans also refresh on demand, so
// nothing waits on this — it just means the first scan often already has
// fresh config instead of defaults.
void loadConfig();

console.log("[bahnbrechend] Background service worker started");
