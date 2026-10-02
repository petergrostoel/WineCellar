# Wine Cellar 🍷

En simpel web-app til at holde styr på vinene i din vinkælder.

## Funktioner

- Tilføj, redigér og slet vine (navn, producent, type, årgang, land, region, druer, pris, placering, noter)
- Hold styr på antal flasker med +/− knapper
- Drikkevindue: viser om vinen skal gemmes, er klar, skal drikkes snart eller er over vinduet
- Søg, filtrér på type og sortér
- Overblik: antal flasker, vine, klar-til-at-drikke og samlet værdi
- Eksport/import af data som JSON (backup)
- Lys og mørk tilstand

## Brug på iPhone

Appen er en PWA (Progressive Web App). Når den ligger på en webadresse med HTTPS:

1. Åbn adressen i **Safari** på iPhone
2. Tryk på **Del**-knappen → **Føj til hjemmeskærm**
3. Appen ligger nu på hjemmeskærmen med eget ikon, åbner i fuld skærm og virker offline

Data gemmes på telefonen (`localStorage`). Brug **Eksportér JSON** til backup.

## Test lokalt på pc'en

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Åbn derefter http://localhost:8080/

## Struktur

```
index.html     – sidens opbygning
styles.css     – udseende (mobil-først, lys/mørk)
app.js         – logik og datahåndtering
manifest.json  – PWA-oplysninger (navn, ikon, farver)
sw.js          – service worker (offline)
icons/         – app-ikoner
serve.ps1      – lille lokal testserver
```

## Backup

Fuld backup (vine, smagninger og etiketbilleder) til `Dokumenter\WineCellar-backup\<dato_tid>\`:

```
powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
```

Scriptet læser kun fra databasen og ændrer intet. Kræver at Supabase CLI i `tools\` er logget ind.
