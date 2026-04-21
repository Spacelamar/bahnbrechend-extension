# Bahnbrechend — Browser Extension

Quellcode der offiziellen **[Bahnbrechend](https://bahnbrechend.net)**-Browser-Extension.
Dieses Repository ist veröffentlicht, damit Nutzer den Code der Extension einsehen
und überprüfen können, die sie auf ihrem Rechner ausführen.

Die Extension optimiert Zugverbindungen für höhere Wahrscheinlichkeit der
Zugbindungsaufhebung auf bahn.de-Sparpreis-Tickets. Sie läuft komplett lokal im
Browser, ruft ausschließlich `int.bahn.de` auf und kommuniziert mit
`bahnbrechend.net` nur für das Senden der Scan-Parameter und das Zurückschicken
der Ergebnisse.

## Lizenz — nicht-kommerzielle Nutzung

Dieser Code steht unter der **[PolyForm Noncommercial License 1.0.0](./LICENSE)**.

> Jede nicht-kommerzielle Verwendung (Code lesen, lokal bauen, forken für private
> Zwecke, Lernen) ist erlaubt. **Jede kommerzielle Verwendung — insbesondere das
> Veröffentlichen einer eigenen Version im Chrome Web Store oder auf AMO, das
> Bündeln in ein kommerzielles Produkt, oder die Nutzung zur Gewinnerzielung —
> ist ohne schriftliche Genehmigung des Autors untersagt.**

Anfragen für kommerzielle Lizenzen an den Autor.

## Stack

- TypeScript + esbuild (Manifest V3 Service Worker)
- Chrome + Firefox (Gecko ≥ 142) — ein Codebase, zwei Manifeste
- Keine externen Laufzeit-Abhängigkeiten (alle npm-Pakete sind dev-only)

## Selbst bauen

```bash
npm ci                  # Deterministisch installieren
node build.mjs          # Baut nach dist/
node pack.mjs           # Erzeugt bahnbrechend-extension.zip + bahnbrechend-firefox.zip
```

Die `dist/`-Ausgabe kann direkt in Chrome als "Entpackte Erweiterung" geladen
werden (`chrome://extensions` → Entwicklermodus aktivieren → "Entpackte
Erweiterung laden").

## Verifizierbarkeit

Siehe **[REPRODUCIBLE.md](./REPRODUCIBLE.md)** — Anleitung wie du den lokal
gebauten Code mit der im Chrome-Store-/Firefox-AMO-veröffentlichten Version
vergleichen kannst, um zu prüfen dass der publizierte Build tatsächlich aus
diesem Quellcode stammt.

## Was die Extension tut (Kurzfassung)

1. Empfängt vom Web-Client (`bahnbrechend.net`) Start-/Ziel-Station + Datum.
2. Ruft `int.bahn.de` ab (Tag-für-Tag, für den konfigurierten Scan-Zeitraum).
3. Optimiert gefundene Verbindungen durch Hinzufügen von Via-Stops (so dass
   die Bahn kurze Umstiege plant — höhere Aufhebungswahrscheinlichkeit).
4. Scored jede Konfiguration mit einem Delay-Modell (Input: Umstiegsdauer +
   eingehender Zugtyp).
5. Sendet Ergebnisse zurück an den Web-Client zum Rendern.

Die Extension speichert **keine** personenbezogenen Daten, macht **keine**
Tracking-Requests und verwendet `sessionStorage` nur für eine zufällige,
per-Tab-Session-ID (für anonyme Seitenaufruf-Zählung).

## Server-Seite

Der Server-Code (API-Endpoints, Scan-Logger, zPair-Pool) liegt in einem separaten,
privaten Repository und ist nicht Teil dieser Veröffentlichung. Die Extension
kann ihn gegen `bahnbrechend.net` (Produktion) oder `localhost:3000` (Entwicklung)
laufen lassen; die Protokoll-Definition steht in
[`src/shared/protocol.ts`](./src/shared/protocol.ts).

## Copyright

Copyright © 2026 Toni Seyfert. Alle Rechte vorbehalten, soweit nicht durch
die [PolyForm Noncommercial License 1.0.0](./LICENSE) eingeräumt.
