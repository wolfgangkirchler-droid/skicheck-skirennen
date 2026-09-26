# skiCHECK Skirennen

Web-App für die wöchentlichen Skischulrennen der skiCHECK Skischulen.

## Ablauf
1. **Teilnehmer**: Odoo-Export (.xlsx) laden, Duplikate prüfen, Skilehrer/innen und Ländercodes ergänzen
2. **Startliste**: Startnummern im 100er-Bereich pro Gruppe vergeben, Startzeiten eintragen, CSV für Lympik und Startlisten-PDF erstellen
3. **Ergebnisse**: Lympik-Ergebnisexport (.xlsx) laden, Ränge prüfen, Ergebnisliste für die Siegerehrung als PDF
4. **Urkunden**: Vorlage und Felder einrichten, Urkunden-PDF für alle Kinder oder eine Gruppe erstellen

## Technik
- Eine einzige Datei (`index.html`), kein Server, kein Build
- Alle Daten bleiben lokal im Browser (IndexedDB); nichts wird auf den Server hochgeladen
- Bibliotheken per CDN: pdf-lib, fontkit, pdf.js (nur beim Hochladen einer PDF-Vorlage)

## Deployment (Render)
Static Site, Build Command leer, Publish Directory `.`
