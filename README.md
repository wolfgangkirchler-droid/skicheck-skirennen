# skiCHECK Skirennen

Web-App für die wöchentlichen Skischulrennen der skiCHECK Skischulen, mit Login, Rechten pro Standort und Rennen-Archiv.

## Ablauf eines Rennens
1. **Neues Rennen** anlegen (Name, Datum, Standort)
2. **Teilnehmer**: Odoo-Export (.xlsx) laden, Duplikate prüfen, Skilehrer/innen und Ländercodes ergänzen
3. **Startliste**: Startnummern im 100er-Bereich pro Gruppe, Startzeiten, CSV für Lympik, Startlisten-PDF
4. **Ergebnisse**: Lympik-Ergebnisexport (.xlsx) laden, Ränge prüfen, Ergebnisliste als PDF
5. **Urkunden**: Urkunden-PDF für alle Kinder oder eine Gruppe

Jedes Rennen wird automatisch gespeichert und bleibt im Archiv.

## Rollen
- **Administrator**: sieht alle Standorte und Rennen, verwaltet Benutzer und Standorte, darf Rennen löschen
- **Standort**: sieht und bearbeitet nur die Rennen des eigenen Standorts

Urkunden-Vorlage, Schriften und Feldpositionen werden pro Standort gespeichert.

## Technik
- Node.js ohne Framework, einzige Abhängigkeit `pg`
- Postgres, alle Tabellen im eigenen Schema `skirennen` (die Datenbank kann mit anderen Apps geteilt werden)
- Passwörter mit scrypt gehasht, Sitzung per HttpOnly-Cookie (30 Tage)

## Render (Web Service)
- Build Command: `npm install`
- Start Command: `npm start`
- Environment:
  - `DATABASE_URL`: Internal Database URL der Postgres-Datenbank
  - `ADMIN_USER`, `ADMIN_PASSWORD`, `ADMIN_NAME`: legt beim ersten Start den Administrator an (nur wenn noch kein Benutzer existiert)
  - optional `FIRST_LOCATION` (Standard: Alpbachtal)

## Lokal testen
`npm run dev` startet mit einem Speicher im Arbeitsspeicher (Login: admin / admin12345).
