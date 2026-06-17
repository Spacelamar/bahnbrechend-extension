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

// Firefox-MV3 keep-alive. Firefox uses an event-page background, not a
// service worker; it suspends the event page after a short idle window
// (empirically much shorter than the documented 30s in recent Firefox
// versions) even when awaits are pending, which breaks long scans —
// the pending `await fetch()` in the scan engine becomes a dead promise
// after suspend. chrome.alarms runs in the browser's system layer,
// outside the page lifecycle, so each fired alarm wakes the event page
// back up. The listener body doesn't need to do anything — the wakeup
// itself is the side effect.
//
// `periodInMinutes: 0.5` (30s) is the minimum the browser accepts.
// A single 30s alarm tested insufficient against the Firefox idle
// window — hangs reproduced reliably whenever the background DevTools
// were not open (DevTools attachment is the only thing that disables
// suspend at the browser level). To shrink the worst-case wakeup gap
// below the idle window, register four alarms offset by 7.5s each:
// every alarm runs at 30s period, but the staggered `when` start
// times produce an effective wakeup every 7.5s. Well below any
// realistic idle timeout. Chrome SW (idle = 30s) is unaffected by
// the staggering — the same wakeups are simply harmlessly redundant.
const KEEPALIVE_OFFSETS_MS = [0, 7500, 15000, 22500];
KEEPALIVE_OFFSETS_MS.forEach((off, i) => {
  chrome.alarms.create(`bahnbrechend-keepalive-${i}`, {
    when: Date.now() + off + 100,
    periodInMinutes: 0.5,
  });
});
chrome.alarms.onAlarm.addListener(() => { /* wakeup-only */ });

// Kick off config fetch at SW start. Scans also refresh on demand, so
// nothing waits on this — it just means the first scan often already has
// fresh config instead of defaults.
void loadConfig();

console.log("[bahnbrechend] Background service worker started");
