# KI-Anweisung: Event-Fotosystem mit automatischer Teilnehmer-Zuordnung

---

## 1. Projektübersicht

Entwickle ein Web-System für Event-Fotografie, das Fotos automatisch den richtigen Teilnehmern zuordnet. es werden durch die Teilnehmer QR Codes erstellt, diese werden abfotografiert, und dienen als trennmarker

### Kernprinzip

Ein Fotograf fotografiert in einer fortlaufenden Serie:

1 **Registrierung** Teilnehmer erstellt QR Code 
2. **QR Code** einer Person → markiert den Start einer neuen Fotoserie
3. **1–n Porträt-/Eventfotos** dieser Person
4. **nächster QR Code** → markiert das Ende der vorherigen und den Start der nächsten Serie

Das System muss diese Sequenz automatisch segmentieren, die QR automatisch auslesen und die Fotos der jeweiligen Person zuordnen.

---

## 2. Zwei Haupt-Flows

### 2.1 Fotografen-Upload-Flow (Backend/Admin)

```
[Fotograf lädt Bilder hoch — in der fotografierten Reihenfolge]
        ↓
[System analysiert jedes Bild:]
        ↓
  ┌─ Ist es ein QR Code? ──→ JA: Neue Person-Session starten
  │                          NEIN: Foto der aktuellen Person-Session zuordnen
  └──────────────────────────
        ↓
[Alle Fotos sind Personen zugeordnet]
```

**Anforderungen:**

- Batch-Upload von Bildern (Drag & Drop, Ordner-Upload)
- Die **Reihenfolge der Bilder muss erhalten bleiben** (nach Dateiname)
- Jedes Bild durchläuft zwei Schritte:
  1. **QR Code erkennung** Ist dieses Bild ein QR Code? (Klassifikation)
  2. **Falls QR Code:** Teilnehmername zuordnen
- Bilder, die vor dem ersten erkannten Ausweis liegen, werden als „nicht zugeordnet" markiert
- Der Fotograf muss eine **Review-Oberfläche** haben, um:
  - Fehlzuordnungen manuell zu korrigieren
  - Falsch oder nicht erkannte Ausweise zu verwerfen oder nachzutragen
  - Den extrahierten Namen zu bearbeiten
- Erst nach einem Review sind Bilder verfügbar

### 2.2 Teilnehmer-Registrierung und Download-Flow (Frontend/Public)

```
[Teilnehmer öffnet Seite]
        ↓
[Registriert sich mit Vor und Nachnamen]
        ↓
[System erstellt QR Code und lässt ihn runterladen]



[Teilnehmer Scannt QR Code]
        ↓
[Zeigt Fotos als Galerie an → Teilnehmer kann Fotos herunterladen]
```


Beide bereiche sind komplett getrennte Webends (Admin und Teilnehmer)

**Anforderungen:**

- Einfache, mobile-optimierte Oberfläche (Teilnehmer nutzen Smartphones)
- Kamera-Zugriff für direktes Abfotografieren des QR Codes
- Download als Einzel-Bilder oder als ZIP-Archiv

---


## 4. Tech-Stack

### 4.1 Frontend — TanStack Start + React

Node.js mit express.js

als frontend nutze bitte Bootstrap. 

Weitere Bibliotheken darfst du nach eingenen ermessen benutzen


### 4.4 Speicher

```
Bildspeicher:
├── Lokales Dateisystem (für Einzelserver-Setup)
└── Thumbnails generieren (sharp / libvips)
```

---

## 5. Datenmodell

```
   ┌──────────────────┐       ┌──────────────┐
   │   Participant    │       │    Photo     │
   ├──────────────────┤       ├──────────────┤ 
   │ id               │──1:n──│ id           │
   │ event_id (FK)    │       │ participant_id│
   │ firstname        │       │ file_path    │
   │ lastname         │       │ thumbnail    │
   │                  │       │ sort_order   │
   │                  │       │ is_badge     │
   │                  │       │ uploaded_at  │
   │ created_at       │       │ file_size    │
   │                  │       │ original_name│
   └──────────────────┘       └──────────────┘

┌──────────────────┐
│  UploadBatch     │
├──────────────────┤
│ id               │
│ event_id (FK)    │
│ status           │  ← pending | processing | review | done
│ total_images     │
│ processed_images │
│ created_at       │
└──────────────────┘
```

jedes bild ist einer Upload Batch zugeordnet

### Feld-Erklärungen

- **is_badge**: Markiert, ob das Bild als QR Code klassifiziert wurde
- **sort_order**: Reihenfolge innerhalb der Upload-Serie (entscheidend für die Zuordnung!)

---

## 6. API-Endpunkte (Vorschlag)

### Admin / Fotograf

```

POST   /api/events/:id/upload         → Bilder hochladen (multipart, Reihenfolge beachten!)
GET    /api/events/:id/batches        → Upload-Batches eines Events
GET    /api/batches/:id/review        → Review-Ansicht (Zuordnungen prüfen)
PATCH  /api/photos/:id                → Foto neu zuordnen / Ausweis-Status ändern
PATCH  /api/participants/:id          → Name korrigieren
POST   /api/batches/:id/confirm       → Batch bestätigen (Fotos werden für Download freigegeben)
```

### Public / Teilnehmer

```
POST   /api/events/:id/lookup         → Ausweis-Bild hochladen → OCR → Fotos zurückgeben
GET    /api/events/:id/download/:pid  → ZIP-Download aller Fotos einer Person
GET    /api/photos/:id/download       → Einzelbild-Download (volle Auflösung)
```

---

## 7. Verarbeitungs-Pipeline (Batch-Upload)

```
Schritt 1: Bilder empfangen
   └── Reihenfolge sicherstellen (Dateiname-Sortierung)

Schritt 2: Sequentielle Analyse (WICHTIG: Reihenfolge beibehalten!)
   ├── Für jedes Bild in Reihenfolge:
   │   ├── QR Code Kontrolle durchführen
   │   ├── Falls QR Code:
   │   │   ├── TEilnehmer zuweisen
   │   │   └── current_participant = dieser Participant
   │   └── Falls kein QR Code:
   │       └── Foto dem current_participant zuordnen
   │
   └── Edge Cases:
       ├── Bild vor erstem Ausweis → „Nicht zugeordnet"-Bucket
       ├── Zwei QR Codes hintereinander → leere Fotoserie (Person ohne Fotos)

Schritt 3: Review-Phase
   └── Fotograf prüft Zuordnungen in der Admin-UI

Schritt 4: Freigabe
   └── Fotograf bestätigt → Fotos werden für Teilnehmer sichtbar
```

---


## 9. UI/UX-Anforderungen

### 9.1 Admin-Oberfläche (Fotograf)

- **Upload-Bereich:** Drag & Drop, Fortschrittsanzeige, Batch-Status
- **Review-Board:**
  - Jede Gruppe zeigt: erkannter Name, Confidence, Anzahl Fotos
  - Drag & Drop zum Umordnen von Fotos zwischen Personen
  - Inline-Edit für Namen
- **Dashboard:** Übersicht (Anzahl Personen, Fotos, Status)

### 9.2 Teilnehmer-Oberfläche

- **Mobile-first** (die meisten Teilnehmer kommen per Smartphone)
- **Startseite:** Einfache Erklärung + großer QR Code scannen"-Button
- **Kamera-Capture:** Direkter Kamerazugriff (MediaDevices API)
- **Ergebnisseite:**
  - Galerie mit Thumbnails
  - Lightbox für Vollbild-Vorschau
  - „Alle herunterladen"-Button (ZIP)
  - Einzelbild-Download
- **Fehlerfall:** Wenn kein Match → erneut Scannen lassen

---
Beide Ui sind separat und nicht untereinder verlinkt. Vorschlag examlpe.com/ -> Teilnehmer example.com/admin -> Admins
## 10. Sicherheit & Datenschutz

### DSGVO-Anforderungen (KRITISCH!)

Da personenbezogene Daten (Name + Fotos) verarbeitet werden:

- **Einwilligung:** Teilnehmer müssen vor dem Fotografieren informiert werden und zustimmen
- **Zweckbindung:** Fotos dürfen nur für den angegebenen Zweck verwendet werden
- **Datenminimierung:** Keine unnötigen Daten speichern
- **Transparenz:** Datenschutzhinweis auf der Download-Seite
- **Löschrecht:** Teilnehmer können die Löschung ihrer Fotos beantragen (nur Text mit anfrage an ansprechpartner aus der env)

### Technische Maßnahmen

- Zugriffskontrolle: Admin-Bereich geschützt (Auth)
- Teilnehmer-Zugriff: Nur über QR Code-Scan (kein öffentlicher Browse aller Fotos)
- HTTPS erzwingen
- Bilder NICHT über erratbare URLs zugänglich machen (UUID-basierte Pfade)
- Rate-Limiting auf dem Lookup-Endpunkt (Brute-Force-Schutz)
- Teilnehmer sehen nur Fotos von sich

---

## 11. Konfigurationsoptionen

Das System sollte konfigurierbar sein:

```yaml
event_config:
  name: "Musterveranstaltung 2026"
  date: "2026-05-15"
  
  ocr:
    languages: ["deu", "eng"]              # Tesseract-Sprachpakete
    min_confidence: 0.6                     # Unter diesem Wert → Review markieren
  
  badge_detection:
    keywords: ["Teilnehmer", "Badge"]      # Zusätzliche Keywords für Ausweis-Erkennung
    text_density_threshold: 0.3            # Ab welcher Textdichte = Ausweis
  
  matching:
    fuzzy_threshold: 2                     # Max Levenshtein-Distanz für Auto-Match
    suggestion_threshold: 5                # Max Distanz für Vorschläge
  
  retention:
    auto_delete_days: 30                   # Automatische Löschung nach n Tagen
  
  download:
    allow_zip: true                        # ZIP-Download erlauben
    max_resolution: "original"             # oder z.B. "2048px"
    watermark: false                       # Optional: Wasserzeichen auf Downloads
```

---

## 12. Edge Cases & Fehlerbehandlung

| Szenario | Verhalten |
|----------|-----------|
| Bilder vor dem ersten QR-Code | → „Nicht zugeordnet"-Bucket, manuell zuweisbar |
| Zwei QR-Codes hintereinander | →  ohne Fotos anlegen (könnte gewollt sein) |
| QR-Code ist unscharf/schlecht beleuchtet | → Niedrige Confidence, Fallback auf manuelle Eingabe |
| Sehr großer Batch (1000+ Bilder) | → Verarbeitung im Hintergrund (Job-Queue), Fortschrittsanzeige |
| Teilnehmer wurde zweimal fotografiert (zwei Ausweis-Serien) | → Fotos unter demselben Namen zusammenführen  |

---

## 13. Performance-Überlegungen

- **Thumbnail-Generierung:** Beim Upload sofort Thumbnails erstellen (z.B. 400px breit)
- **Lazy Loading:** In der Galerie nur Thumbnails laden, Originale on-demand
- **CDN / Caching:** Thumbnails cachen, Originale nur bei Download ausliefern
- **Upload-Chunking:** Große Batches in Chunks hochladen (Resumable Uploads, z.B. tus-Protokoll)

---

## 14. Empfohlene Bibliotheken


---

## 15. Meilensteine / Entwicklungsreihenfolge

```
Phase 1: Grundgerüst
├── Projektsetup 
├── Datenbank-Schema
├── Bild-Upload (einzeln + Batch)
└── Bildspeicher + Thumbnail-Generierung

Phase 2: Kernlogik
└── Sequentielle Zuordnungs-Pipeline

Phase 3: Admin-UI
├── Upload-Flow
├── Review-Board
├── Manuelle Korrektur-Möglichkeiten
└── Event-Dashboard

Phase 4: Teilnehmer-UI


Phase 5: Härtung
├── DSGVO-Maßnahmen (Löschfristen, Datenschutzhinweise)
├── Rate-Limiting + Sicherheit
├── Performance-Optimierung
└── Error-Handling + Logging
```

---

## 16. Offene Punkte / TODOs


- [ ] **Hosting-Entscheidung** (eigener Server, Cloud, etc.) — 
- [ ] **Datenbank-Wahl** (SQLite mit Drizzle ORM für einfaches Setup, PostgreSQL für Skalierung) -> SQLite oder Postgres zur auswahl in env)
- [ ] **Auth-Lösung** für Admin-Bereich (z.B. simple Password-Protection, OAuth, etc.) - simpler PAsswortschutz vor dem kompletten Admin UI
- [ ] **Wasserzeichen** auf Fotos ja/nein? -> Konfigurierbar im Admin bereich

---

*Dieses Dokument dient als vollständige Anweisung für eine KI oder ein Entwicklungsteam, um das Event-Fotosystem zu implementieren. Alle Abschnitte sollten als Anforderung verstanden werden, sofern nicht als „optional" markiert.*
