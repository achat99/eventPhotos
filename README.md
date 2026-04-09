# Event-Fotosystem

MVP für ein Event-Fotosystem mit QR-basierten Trennmarkern, Admin-Review und Teilnehmergalerie.

## Start

```bash
cp .env.example .env
npm install
npm run dev:host
```

Danach öffnen:

- Teilnehmer: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin`

## Standard-Zugang

- Admin-Passwort: `eventphotos123`

## Hauptfunktionen

- Teilnehmer-Registrierung mit QR-Code-Download
- Batch-Upload für Fotografen mit Dateinamen-Sortierung
- Automatische QR-Erkennung als Serien-Trennmarker
- Review-Oberfläche zum Korrigieren von Zuordnungen
- Freigabeprozess vor öffentlicher Sichtbarkeit
- Einzelbild- und ZIP-Download für Teilnehmer
