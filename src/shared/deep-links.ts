import { Station } from "./types";

/**
 * Generate a deep link to bahn.de booking search with Zwischenhalte.
 *
 * Uses the bahn.de hash-fragment URL format:
 * - so/zo: station names
 * - soid/zoid: station IDs (O=Name format works)
 * - hd: departure date/time (ISO format)
 * - hza: D=departure
 * - hz: Zwischenhalte as JSON array of arrays:
 *        [["A=1@O=Name@L=EVA_ID@", "Name", aufenthaltMinuten], ...]
 * - kl: class (2 = 2nd)
 *
 * Max 2 via stations supported by DB.
 */
export function generateBookingLink(
  from: Station,
  to: Station,
  viaStops: Station[],
  date: string,
  departureTime?: string
): string {
  // Format departure in Europe/Berlin timezone to avoid UTC offset issues
  const d = new Date(departureTime || date);
  const berlinParts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => berlinParts.find((p) => p.type === type)?.value || "00";
  const isoDate = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:00`;

  // Build hz parameter: array of [hafasId, name, stopoverMinutes]
  const hzArray = viaStops.slice(0, 2).map((s) => [
    `A=1@O=${s.name}@L=${s.id}@`,
    s.name,
    2, // min. 2 Minuten Aufenthalt, sonst ignoriert bahn.de den Zwischenhalt
  ]);

  const params: string[] = [
    `sts=true`,
    `so=${encodeURIComponent(from.name)}`,
    `zo=${encodeURIComponent(to.name)}`,
    `kl=2`,
    `r=13:16:KLASSENLOS:1`,
    `soid=${encodeURIComponent(`O=${from.name}`)}`,
    `zoid=${encodeURIComponent(`O=${to.name}`)}`,
    `hd=${encodeURIComponent(isoDate)}`,
    `hza=D`,
    `hz=${encodeURIComponent(JSON.stringify(hzArray))}`,
    `ar=false`,
    `s=true`,
    `d=false`,
    `fm=false`,
    `bp=false`,
  ];

  return `https://www.bahn.de/buchung/fahrplan/suche#${params.join("&")}`;
}

/**
 * Generate textual booking instructions for via stops.
 */
export function generateBookingInstructions(viaStops: Station[]): string {
  if (viaStops.length === 0) return "";

  const stationNames = viaStops.map((s) => s.name).join(" → ");
  return `Zwischenhalte hinzufügen: ${stationNames}`;
}
