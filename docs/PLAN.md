# Wine Cellar – vision og plan

## Vision

En vinkælder-app til iPhone, der er **ekstremt nem at bruge**. Du skal ikke udfylde skemaer.
Du tager et billede, og appen finder selv oplysningerne om vinen på nettet.

## Kernefunktioner

### 1. Ny vin – foto → antal → gem
1. Tryk **📷 Ny vin** og fotografér etiketten.
2. AI genkender vinen og finder oplysninger på nettet:
   navn, producent, årgang, land/region, druer, type,
   **kort beskrivelse af karakter og smag**, **ideelt drikkevindue** og **madparring**.
3. Du ser resultatet, vælger antal flasker og trykker **Gem**. Du kan rette alt, hvis AI har taget fejl.

Hver årgang er en separat vin, fordi drikkevinduet er forskelligt.

### 2. Drik en vin – foto → én flaske mindre
1. Tryk **🍷 Drik** og fotografér flasken.
2. Appen finder vinen i din beholdning og spørger, om der skal trækkes én flaske fra.
3. Du kan give **1–5 stjerner** og skrive **egne noter**. Begge dele er valgfrie.
4. Når den sidste flaske er drukket, flyttes vinen til **Drukket** (historik), så du kan se, hvad du har drukket, og hvad der var godt.

### 3. Drikkevindue med farvekoder
| Farve | Betyder |
|---|---|
| 🔴 Rød | Ikke klar endnu |
| 🟢 Lysegrøn | Snart klar – bliver klar næste år |
| 🟡 Gul | Sidste år i vinduet – på vej ud |
| 🟢 Grøn | I det ideelle vindue |
| ⚪ Grå | Over vinduet |

Forsiden viser **"Skal snart drikkes"** øverst.

### 4. Hvad skal jeg drikke til maden?
Du skriver en ret og får **top 5 fra din egen kælder** med kort begrundelse og farvekode.
Vægtningen kombinerer:
- **Hvor godt vinen passer** til retten
- **Hvor meget det haster** – en vin, der er ved at løbe ud, rykker op

Er der ingen hvidvin i top 5, foreslås den bedste hvidvin som nr. 6.

### 5. Tidslinje
- Kurve fra i år og frem: antal drikkeklare flasker pr. år (grønt), med "snart klar / sidste år" (gult) og "ikke klar" (rødt) ovenpå. Tryk for at se tal. Trykket år filtrerer også listen over drikkevinduer til det år (farver og sortering for det år; "Vis i år" nulstiller).
- Drikkevindue pr. vin som livscyklus-bjælke fra i år til det sidste år, hvor en vin i kælderen er i sit vindue – farvet år for år (rød → gul → grøn → gul → grå). Sorteret: klar og tættest på at udløbe øverst (mindst af vinduet tilbage), lige blevet klar nederst, derefter dem der endnu ikke er klar.
- Liste over vine der er over vinduet – med "Kassér" og "Del / kopiér listen".

## Teknik

```
iPhone (PWA)  ──►  Supabase Edge Function  ──►  Google Gemini (gratis)
                    • holder AI-nøglen hemmelig      • læser etiketten
                    • kræver dit login               • (søger på Google, hvis muligt)
      │
      └──►  Supabase database + billedlager (EU)
```

- **App:** PWA på GitHub Pages – https://petergrostoel.github.io/WineCellar/
- **Data:** Supabase (Irland, EU) – database med login og Row Level Security
- **Billeder:** Supabase Storage, privat mappe pr. bruger. Billederne gøres mindre på telefonen før upload.
- **AI:** Google Gemini, gratis udgave (Flash-model). Google-søgning bruges automatisk, hvis den er tilgængelig (kræver betalingskort på Gemini-nøglen) – ellers svarer AI'en ud fra egen viden.
  Al AI-kode ligger i én Edge Function, så tjenesten kan skiftes (fx til Claude) uden at ændre appen.

## Datamodel

**wines** – én række pr. vin og årgang
- navn, producent, årgang, type, land, region, druer
- antal flasker, pris, placering
- `description` – karakter og smag
- `drink_from`, `drink_to` – ideelt drikkevindue (år)
- `food_pairings` – liste af madtyper
- `image_path` – etiketbillede
- `ai_sources` – kilder AI har brugt

**tastings** – én række pr. drukket flaske
- vin, dato, stjerner (1–5), egne noter

## Byggetrin

1. ✅ Grundapp, PWA, GitHub Pages, login og online-lagring
2. ✅ Database: nye felter, `tastings`-tabel og billedlager
3. ✅ Edge Function med Gemini: genkend etiket, find vin i beholdning, madanbefaling
4. ✅ Ny forside: farvekoder, "Skal snart drikkes" og store knapper til foto
5. ✅ Flow: **Ny vin** med foto
6. ✅ Flow: **Drik** med foto, stjerner og noter, samt **Drukket**-historik
7. ✅ Flow: **Hvad skal jeg drikke?** (top 5 + bedste hvidvin som nr. 6)
8. ✅ Tidslinje: kurve over drikkeklare flasker pr. år, drikkevinduer pr. vin og liste over vine der er over vinduet
9. Test og finpudsning på iPhone
