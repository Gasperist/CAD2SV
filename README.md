# CAD2SV

CAD-Plan als PDF laden, skalieren, Flächen in 2D und 3D nachzeichnen und als `.txt` für Soundvision exportieren.

## Starten

Doppelklick auf `CAD2SV.app`, oder `index.html` direkt im Browser öffnen. Das Tool läuft komplett lokal: PDFs und Zeichnungen verlassen den Rechner nicht.

## In Soundvision importieren

1. Im Tool auf **Für Soundvision exportieren** klicken und die `.txt` speichern.
2. In Soundvision das Panel **3D ROOM DATA** öffnen und **Import 3D room data** wählen.
3. Die Hörhöhe in Soundvision einstellen, das Format überträgt sie nicht.

## Offline nutzen

Die PDF-Bibliothek pdf.js liegt in `vendor/`. Fehlt sie, lädt das Tool sie aus dem Internet.

```bash
mkdir -p vendor
curl -o vendor/pdf.min.js https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
curl -o vendor/pdf.worker.min.js https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
```

## Tests

```bash
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc test/logic_test.js
```

## Tastenkürzel

| Taste | Funktion |
|---|---|
| V, R, T, P, C, A | Auswahl, Rechteck, Schräg, Polygon, Kreis, Bogen |
| K, N, L, M | Skalieren, Nullpunkt, Ausrichten, Messen |
| 1, 2, 3, 4 | Draufsicht, Seite, Front, 3D |
| F, S, G | Einpassen, Fangen, Raster |
| Shift | Gerade Linien, Quadrat, Eckpunkt nur senkrecht oder waagrecht |
| Alt | Fangen kurz aussetzen |
| Leertaste + Ziehen | Ansicht verschieben |
| ⌘Z, ⇧⌘Z, ⌘D, ⌘S | Rückgängig, Wiederholen, Duplizieren, Projekt speichern |
