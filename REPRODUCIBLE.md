# Build-Verifizierung

Diese Anleitung erklärt, wie du überprüfen kannst, ob die Bahnbrechend-Extension,
die im Chrome Web Store bzw. auf Firefox AMO veröffentlicht ist, **tatsächlich aus
dem hier publizierten Quellcode** gebaut wurde.

Der Vergleich erfolgt auf Ebene der gebauten Dateien (`background.js`,
`content.js`, `manifest.json`, Icons, `rules.json`), **nicht** auf Ebene der
Store-ZIP-Datei — weil der Store-Upload von Chrome/Firefox kleine Metadaten
(Signaturen, `_metadata/`) einbettet, die wir beim lokalen Build nicht
reproduzieren können. Die eigentlichen, vom Browser ausgeführten Dateien sind
aber identisch.

## Voraussetzungen

- Node.js 22 (oder 24 — LTS reicht)
- Git
- Die installierte Extension-Version soll mit dem Commit übereinstimmen, den du
  prüfst. Die Version steht in der installierten Extension unter
  `chrome://extensions` → Details, und ist hier im Repo im `manifest.json`
  hinterlegt sowie als Git-Tag (z.B. `v1.2.0`).

## Schritt 1: Repo clonen und bauen

```bash
git clone https://github.com/Spacelamar/bahnbrechend-extension.git
cd bahnbrechend-extension
git checkout v1.2.0          # Oder welche Version du prüfst
npm ci                       # Deterministisch, nutzt package-lock.json
node build.mjs               # Baut nach dist/
```

## Schritt 2: Installierte Chrome-Extension finden

Chrome legt entpackte Kopien der installierten Extensions hier ab:

- **Windows**: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\fnpfplhpgaailnjdkalfeebgfdkemodo\<VERSION>\`
- **macOS**: `~/Library/Application Support/Google/Chrome/Default/Extensions/fnpfplhpgaailnjdkalfeebgfdkemodo/<VERSION>/`
- **Linux**: `~/.config/google-chrome/Default/Extensions/fnpfplhpgaailnjdkalfeebgfdkemodo/<VERSION>/`

Die ID `fnpfplhpgaailnjdkalfeebgfdkemodo` ist die Chrome-Web-Store-ID von
Bahnbrechend. Falls du ein anderes Chrome-Profil verwendest, ersetze `Default`
entsprechend.

Für Firefox liegen die entpackten Extensions unter (je nach OS unterschiedlich,
z.B.): `~/.mozilla/firefox/<profile>/extensions/extension@bahnbrechend.net.xpi`
— das ist eine ZIP-Datei, die du mit `unzip` entpackst.

## Schritt 3: Vergleichen

Vergleiche den Inhalt deines `dist/`-Ordners mit dem entpackten Store-Ordner.
Unter Linux/macOS:

```bash
diff -r dist/ "<PFAD ZUM STORE-ORDNER>/"
```

Unter Windows (PowerShell):

```powershell
Compare-Object `
  (Get-ChildItem -Recurse dist\ | ForEach-Object { Get-FileHash $_.FullName }) `
  (Get-ChildItem -Recurse "<PFAD ZUM STORE-ORDNER>\" | ForEach-Object { Get-FileHash $_.FullName }) `
  -Property Hash
```

**Erwartetes Ergebnis:** keine Unterschiede bei den JavaScript-Dateien, dem
Manifest, `rules.json` und den Icons.

**Erwartete Unterschiede (harmlos):**

- `_metadata/` Ordner — Chrome fügt zur Laufzeit eine `verified_contents.json`
  o.ä. hinzu; das ist ein Store-Signatur-Artefakt.
- Eventuell ein zusätzlicher `_locales/`-Ordner falls der Store
  Lokalisierungs-Dateien hinzufügt (wir liefern keine → sollte nicht
  vorkommen).

Wenn du Unterschiede in `background.js`, `content.js`, `manifest.json` oder
`rules.json` findest die über Whitespace hinausgehen, **ist das ein Alarm** —
bitte melden unter [bahnbrechend.net](https://bahnbrechend.net) oder als Issue
hier im Repo.

## Was ist nicht reproducible?

Die Store-ZIPs (`bahnbrechend-extension.zip`, `bahnbrechend-firefox.zip`) sind
**nicht byte-identisch** mit dem Upload, weil der Store sie neu verpackt. Für
die Sicherheits-Verifizierung ist das irrelevant — was zählt sind die
tatsächlich ausgeführten JavaScript-Dateien, und die prüfst du oben per `diff`.

## Bekannte Build-Determinismen

- `esbuild` ist deterministisch solange die Input-Dateien und `package-lock.json`
  fest sind → gleicher Output bei gleichem Commit.
- `pack.mjs` verwendet JSZip mit DEFLATE Level 9 und sortierter File-Reihenfolge
  → gleicher lokaler Build produziert gleiches ZIP (aber nicht gleich zum
  Store-ZIP, siehe oben).
- Keine Build-Zeit-Timestamps im Output.
- Keine Umgebungsvariablen oder Git-SHA im Output.
