// Wine Cellar – AI-funktion (Supabase Edge Function).
//
// Holder Gemini-nøglen hemmelig og kræver, at brugeren er logget ind.
// Al AI-logik ligger her, så AI-tjenesten kan skiftes uden at ændre appen.
//
// Handlinger (POST JSON med feltet "action"):
//   identify – { image }                 → oplysninger om vinen på etiketten
//   match    – { image, wines }          → hvilken vin i beholdningen billedet viser
//   pair     – { dish, wines, year }     → top 5 vine til retten
//   price    – { wine }                  → prisspænd hos danske vinbutikker (kræver søgning)
//   usage    – {}                        → AI-forbrug (søgninger denne måned, skønnet pris i år)
//   models   – {}                        → hvilke Gemini-modeller nøglen kan bruge

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Modellerne prøves i rækkefølge, til én svarer – bedste model først (betalt
// udgave), de øvrige som reserve, hvis Google har travlt. Kan overstyres med
// hemmeligheden GEMINI_MODEL.
const MODELS = (Deno.env.get("GEMINI_MODEL") ??
  "gemini-3.8-flash,gemini-flash-latest,gemini-3.6-flash,gemini-flash-lite-latest")
  .split(",").map((m) => m.trim()).filter(Boolean);
const DEADLINE_MS = 100_000; // Supabase stopper funktionen efter 150 sek.
// Google-søgning er ikke med i den gratis kvote. Tilknyt betalingskort til
// Gemini-nøglen og sæt hemmeligheden GEMINI_SEARCH=true for at slå den til.
const SEARCH_ENABLED = Deno.env.get("GEMINI_SEARCH") === "true";
// Når Google-søgning er afvist, prøves den ikke igen i en time (sparer tid).
let searchBlockedUntil = 0;
const API = "https://generativelanguage.googleapis.com/v1beta";
const WINE_TYPES = ["Rød", "Hvid", "Rosé", "Orange", "Mousserende", "Dessert", "Hedvin"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------- Login-tjek ----------

async function requireUser(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  if (!auth.startsWith("Bearer ") || !apikey) throw new HttpError(401, "Du skal være logget ind.");
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: auth, apikey },
  });
  if (!res.ok) throw new HttpError(401, "Dit login er udløbet – log ind igen.");
  return await res.json();
}

// ---------- Forbrug: varsling og loft ----------
//
// Hvert kald registreres i tabellen ai_usage (alle brugere samlet, da de deler
// nøglen). Ud fra det varsles ved 80 %, Google-søgning stoppes ved 95 % af den
// gratis månedskvote, og AI'en lukkes helt, når årets skønnede pris når loftet.
// Prisen er et skøn ud fra Googles prisliste; den sikre bremse er forudbetaling
// uden automatisk genopfyldning hos Google.

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Sættes til "true", når der er tilknyttet betaling til Gemini-nøglen.
const BILLING = Deno.env.get("GEMINI_BILLING") === "true";
const YEAR_CAP_DKK = Number(Deno.env.get("AI_YEAR_CAP_DKK") ?? 100);
const USD_DKK = Number(Deno.env.get("USD_DKK") ?? 7); // bevidst lidt højt sat
const FREE_SEARCHES = Number(Deno.env.get("SEARCH_FREE_PER_MONTH") ?? 5000);
const WARN_SHARE = 0.8;
const SEARCH_STOP_SHARE = 0.95;
const SEARCH_PRICE_USD = 14 / 1000; // efter den gratis kvote

// Googles pris for Gemini Flash i USD pr. 1 mio. tokens (tænkning tæller som output).
function flashPrices(d = new Date()) {
  return d.getUTCFullYear() >= 2027 ? { input: 1.5, output: 7.5 } : { input: 0.75, output: 3.75 };
}

type Usage = {
  billing: boolean;
  searchEnabled: boolean;
  yearCostDkk: number;
  capDkk: number;
  monthSearches: number;
  searchLimit: number;
};
type Ctx = { userId: string | null; action: string; usage?: Usage | null };

function rest(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function usageSummary(): Promise<Usage | null> {
  try {
    const res = await rest("rpc/ai_usage_summary", { method: "POST", body: "{}" });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const s = await res.json();
    return {
      billing: BILLING,
      searchEnabled: SEARCH_ENABLED,
      yearCostDkk: Math.round(Number(s.year_cost_usd) * USD_DKK * 100) / 100,
      capDkk: YEAR_CAP_DKK,
      monthSearches: Number(s.month_searches) || 0,
      searchLimit: FREE_SEARCHES,
    };
  } catch (err) {
    console.error("AI-forbrug kunne ikke hentes", String(err));
    return null;
  }
}

function usageWarnings(u: Usage | null | undefined) {
  const w: string[] = [];
  if (!u) return w;
  const kr = (n: number) => n.toLocaleString("da-DK", { maximumFractionDigits: 0 });
  if (u.billing && u.yearCostDkk >= u.capDkk * WARN_SHARE) {
    w.push(`AI-forbruget i år er ca. ${kr(u.yearCostDkk)} kr af loftet på ${kr(u.capDkk)} kr.`);
  }
  if (u.searchEnabled && u.monthSearches >= u.searchLimit * WARN_SHARE) {
    w.push(`${u.monthSearches.toLocaleString("da-DK")} af ${u.searchLimit.toLocaleString("da-DK")} gratis Google-søgninger er brugt i denne måned.` +
      (u.monthSearches >= u.searchLimit * SEARCH_STOP_SHARE ? " Søgning er sat på pause resten af måneden." : ""));
  }
  return w;
}

type Meta = { promptTokenCount?: number; toolUsePromptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };

async function recordUsage(ctx: Ctx, model: string, searched: boolean, meta: Meta | undefined, queries: number, monthBefore: number) {
  const input = (meta?.promptTokenCount ?? 0) + (meta?.toolUsePromptTokenCount ?? 0);
  const output = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
  const p = flashPrices();
  const paidSearches = Math.max(0, monthBefore + queries - FREE_SEARCHES) - Math.max(0, monthBefore - FREE_SEARCHES);
  const cost = BILLING ? (input / 1e6) * p.input + (output / 1e6) * p.output + paidSearches * SEARCH_PRICE_USD : 0;
  try {
    const res = await rest("ai_usage", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: ctx.userId, action: ctx.action, model, searched, search_queries: queries,
        input_tokens: input, output_tokens: output, cost_usd: Math.round(cost * 1e6) / 1e6,
      }),
    });
    if (!res.ok) console.error("AI-forbrug kunne ikke gemmes", res.status, await res.text());
  } catch (err) {
    console.error("AI-forbrug kunne ikke gemmes", String(err));
  }
}

// ---------- Gemini ----------

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

// Med search=true forsøges Google-søgning først (når det er slået til og der er
// kvote tilbage). Ellers svarer modellen ud fra sin egen viden – medmindre
// requireSearch er sat (fx prisopslag), så afvises kaldet i stedet for at gætte.
async function gemini(parts: Part[], { search = false, requireSearch = false, models = MODELS, thinking, ctx }:
  { search?: boolean; requireSearch?: boolean; models?: string[]; thinking?: "low" | "high"; ctx: Ctx }) {
  if (requireSearch) search = true;
  const usage = await usageSummary();
  ctx.usage = usage;
  if (BILLING && usage && usage.yearCostDkk >= YEAR_CAP_DKK) {
    throw new HttpError(402, `Årsloftet for AI på ${YEAR_CAP_DKK} kr er nået, så foto-genkendelse og madforslag er lukket til 1. januar. Resten af appen virker som normalt.`);
  }
  // Uden overblik over forbruget søges der ikke (så kvoten aldrig overskrides ubemærket).
  const searchAllowed = search && SEARCH_ENABLED && Date.now() > searchBlockedUntil &&
    usage !== null && usage.monthSearches < FREE_SEARCHES * SEARCH_STOP_SHARE;
  if (requireSearch && !searchAllowed) {
    throw new HttpError(503, SEARCH_ENABLED
      ? "Google-søgning er sat på pause resten af måneden (den gratis kvote er næsten brugt), så prisen kan ikke slås op lige nu."
      : "Prisopslag kræver Google-søgning, som ikke er slået til.");
  }

  const deadline = Date.now() + DEADLINE_MS;
  let result: Awaited<ReturnType<typeof callGemini>> & { searched: boolean };
  if (searchAllowed) {
    try {
      result = { ...(await callGemini(parts, true, deadline, models, thinking)), searched: true };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (err.status === 429) searchBlockedUntil = Date.now() + 60 * 60 * 1000;
      if (requireSearch) throw err;
      console.warn("Google-søgning mislykkedes – svarer uden søgning");
      result = { ...(await callGemini(parts, false, deadline, models, thinking)), searched: false };
    }
  } else {
    result = { ...(await callGemini(parts, false, deadline, models, thinking)), searched: false };
  }
  // Google oplyser ikke altid, hvor mange søgninger der blev lavet. Et kald med
  // søgning tælles derfor som mindst én, så kvoten hellere tælles for højt end for lavt.
  const searches = result.searched ? Math.max(result.queries, 1) : 0;
  await recordUsage(ctx, result.model, result.searched, result.meta, searches, usage?.monthSearches ?? 0);
  if (usage) usage.monthSearches += searches;
  return result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(parts: Part[], search: boolean, deadline: number, models: string[] = MODELS, thinking?: "low" | "high") {
  if (!GEMINI_API_KEY) throw new HttpError(500, "GEMINI_API_KEY mangler i Supabase.");
  const body = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) },
    ...(search ? { tools: [{ google_search: {} }] } : {}),
  });

  const statuses: number[] = [];
  // Op til to runder: modeller der er overbelastede (503/500) prøves igen.
  let candidates = [...models];
  for (let round = 0; round < 2 && candidates.length; round++) {
    if (round > 0) await sleep(2500);
    const retry: string[] = [];
    for (const model of candidates) {
      const left = deadline - Date.now();
      if (left < 5000) break;
      let res: Response;
      try {
        res = await fetch(`${API}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
          body,
          // Søgninger må tage længere tid (de besøger mange sider).
          signal: AbortSignal.timeout(Math.min(search ? 90_000 : 45_000, left)),
        });
      } catch (err) {
        console.error("Gemini-timeout", model, String(err));
        statuses.push(504);
        continue;
      }
      if (res.ok) {
        const data = await res.json();
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts ?? [])
          .map((p: { text?: string }) => p.text ?? "")
          .join("");
        if (!text) {
          console.error("Tomt svar fra", model, cand?.finishReason);
          statuses.push(502);
          continue;
        }
        const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
          .map((c: { web?: { uri?: string; title?: string } }) => c.web)
          .filter((w: unknown) => w)
          .map((w: { uri?: string; title?: string }) => ({ url: w.uri, title: w.title }));
        const queries = (cand?.groundingMetadata?.webSearchQueries ?? []).length;
        return { text, sources, model, meta: data.usageMetadata as Meta | undefined, queries };
      }
      const detail = `${model}: ${res.status} ${(await res.text()).slice(0, 200)}`;
      console.error("Gemini-fejl", detail);
      statuses.push(res.status);
      if (res.status === 503 || res.status === 500) retry.push(model);
    }
    candidates = retry;
  }

  if (statuses.length && statuses.every((s) => s === 429)) {
    throw new HttpError(429, "Den gratis AI-kvote er brugt op for nu. Prøv igen senere.");
  }
  if (statuses.length && statuses.every((s) => s === 504)) {
    throw new HttpError(504, "AI'en brugte for lang tid på at svare. Prøv igen om lidt.");
  }
  if (statuses.some((s) => s === 503 || s === 500 || s === 504)) {
    throw new HttpError(503, "Googles AI er overbelastet lige nu. Prøv igen om et øjeblik.");
  }
  throw new HttpError(502, "AI'en svarede ikke. Prøv igen om lidt.");
}

function parseJson(text: string) {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start < 0 || end < start) throw new HttpError(502, "AI'en gav et svar, appen ikke kunne læse. Prøv igen.");
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new HttpError(502, "AI'en gav et svar, appen ikke kunne læse. Prøv igen.");
  }
}

function imagePart(image: unknown): Part {
  if (typeof image !== "string" || image.length < 100) throw new HttpError(400, "Billedet mangler.");
  const m = image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  return { inline_data: { mime_type: m?.[1] ?? "image/jpeg", data: m?.[2] ?? image } };
}

const intOrNull = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== "" ? Math.round(n) : null;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Prisspænd hos danske butikker. Accepteres kun, hvis AI'en faktisk har søgt, og
// mindst én kilde er en dansk vinbutik – ellers kunne prisen være gættet.
// Danske vinbutikker kendes på .dk – eller står på listen herunder, fordi deres
// webshop har et udenlandsk domæne.
const DANISH_SHOPS_OTHER_DOMAINS = ["philipsonwine.com"];
type Source = { url?: string; title?: string };
function isDanishShop(title: string) {
  return /\.dk\b/.test(title) || DANISH_SHOPS_OTHER_DOMAINS.some((d) => title.includes(d));
}
function danishPrice(raw: unknown, sources: Source[], searched: boolean) {
  const r = raw as { min?: unknown; max?: unknown } | null;
  if (!searched || !r) return null;
  const shops = [...new Set(sources
    .map((s) => (s.title ?? "").trim().toLowerCase())
    .filter(isDanishShop))];
  if (!shops.length) return null;
  const num = (v: unknown) => {
    const n = Number(String(v ?? "").replace(/\s|kr\.?/gi, "").replace(",", "."));
    return Number.isFinite(n) && n >= 20 && n <= 100000 ? Math.round(n) : null;
  };
  let min = num(r.min), max = num(r.max);
  if (min === null && max === null) return null;
  min ??= max;
  max ??= min;
  if (min! > max!) [min, max] = [max, min];
  return { min, max, shops: shops.slice(0, 5), checked: new Date().toISOString().slice(0, 10) };
}

const PRICE_DK_PROMPT = `"offers": [{"shop": "butik", "url": "link til produktsiden", "price": 229, "vintage": 2019}], // priser i kr pr. 75 cl-flaske hos DANSKE vinbutikker, helst samme årgang. Søg efter vinen + "pris" hos danske forhandlere. Kun priser du har fundet i søgningen, med link til produktsiden – ellers []`;

// Prisen godkendes kun, hvis butikkens egen side findes, er dansk, nævner vinen
// og viser prisen. Så kan AI'en ikke finde på en pris (Google sender ikke altid
// sine søgekilder med tilbage, så de kan ikke bruges som bevis).
type Offer = { shop?: unknown; url?: unknown; price?: unknown; vintage?: unknown };
async function verifyDanishOffers(offers: unknown, wine: { producer?: string; name?: string }) {
  if (!Array.isArray(offers)) return null;
  const words = [str(wine.producer), str(wine.name)].join(" ").toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/).filter((t) => t.length > 3);
  const checks = (offers as Offer[]).slice(0, 6).map(async (o) => {
    const p = Number(String(o.price ?? "").replace(/\s|kr\.?/gi, "").replace(",", "."));
    let url: URL;
    try {
      url = new URL(String(o.url ?? ""));
    } catch {
      return null;
    }
    if (!(p >= 20 && p <= 100000) || !isDanishShop(url.hostname)) return null;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (WineCellar prischeck)", "Accept-Language": "da-DK,da" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const page = (await res.text()).toLowerCase();
      const int = Math.floor(p);
      const dec = String(Math.round((p - int) * 100)).padStart(2, "0");
      const priceShown = [`${int},${dec}`, `${int}.${dec}`, ...(dec === "00" ? [`${int},-`, `${int} kr`, `${int}kr`] : [])]
        .some((s) => page.includes(s));
      const nameShown = words.length === 0 || words.filter((t) => page.includes(t)).length >= Math.min(2, words.length);
      if (!priceShown || !nameShown) return null;
      return { price: Math.round(p), shop: url.hostname.replace(/^www\./, ""), vintage: intOrNull(o.vintage) };
    } catch {
      return null;
    }
  });
  const ok = (await Promise.all(checks)).filter((x) => x !== null);
  if (!ok.length) return null;
  const prices = ok.map((x) => x!.price);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    shops: [...new Set(ok.map((x) => x!.shop))],
    checked: new Date().toISOString().slice(0, 10),
  };
}

// Alkoholprocent: accepterer "13,5" og 13.5; urimelige værdier bliver null.
function abvOrNull(v: unknown) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", ".").replace("%", ""));
  return Number.isFinite(n) && n >= 0 && n <= 25 ? Math.round(n * 10) / 10 : null;
}

// ---------- identify: genkend en ny vin ----------

async function identify(input: { image: unknown }, ctx: Ctx) {
  const year = new Date().getFullYear();
  const prompt = `Du er en erfaren sommelier. Billedet viser en vinflaske eller en vinetiket.
1. Aflæs etiketten nøjagtigt: navn, producent, årgang, appellation/region og land.
2. Find druer, smagsprofil og hvornår netop denne vin og årgang bør drikkes. Har du Google-søgning, SKAL du søge mindst én gang efter producent + vin + årgang (producentens side, anmeldelser, vinguider) og bygge drikkevinduet på det, du finder. Uden søgning: brug din egen viden om producenten, området og årgangen.
3. Vurdér det ideelle drikkevindue for netop denne årgang som årstal. Det er nu år ${year}.

Svar KUN med ét JSON-objekt, uden forklaring før eller efter, med disse felter:
{
  "is_wine": true/false,            // false hvis billedet ikke viser en vin
  "name": "vinens navn uden producent og årgang, fx 'Barolo Cannubi'",
  "producer": "producent",
  "vintage": 2016,                  // årstal eller null hvis ikke angivet (fx NV champagne)
  "assumed_vintage": 2022,          // KUN hvis vintage er null: den årgang du gik ud fra, da du satte drikkevinduet (fx den årgang der er i handlen nu); ellers null
  "type": "en af: ${WINE_TYPES.join(", ")}", // "Orange" = hvidvin lavet med skindkontakt (orange wine / amber)
  "country": "land på dansk",
  "region": "region/appellation",
  "grapes": "druer, kommasepareret",
  "description": "2–3 korte sætninger PÅ DANSK om vinens karakter og smag (krop, syre, tanniner, aromaer)",
  "drink_from": 2024,               // første år i det ideelle drikkevindue
  "drink_to": 2035,                 // sidste år i det ideelle drikkevindue
  "food_pairings": ["3–6 korte madtyper på dansk, fx 'lam', 'svampe', 'modne oste'"],
  "abv": 13.5,                      // alkoholprocent fra etiketten (fx "13,5% vol"), ellers dit bedste bud eller null
  "natural": true/false,            // naturvin: fx "vin nature", "natural wine", "sans sulfites ajoutés", eller producenten er kendt for naturvin
  "alcohol_free": true/false,       // alkoholfri: under 1 % alkohol, fx "0,0 %", "alkoholfri", "dealcoholised"
  ${PRICE_DK_PROMPT}
  "confidence": "høj | middel | lav", // hvor sikker du er på genkendelsen
  "uncertain": "kort dansk note om hvad der er usikkert, eller tom streng"
}`;

  const { text, sources, model, searched } = await gemini([imagePart(input.image), { text: prompt }], { search: true, ctx });
  const r = parseJson(text);
  if (r.is_wine === false) throw new HttpError(422, "Jeg kan ikke se en vinetiket på billedet. Prøv igen tættere på etiketten.");

  const type = WINE_TYPES.find((t) => t.toLowerCase() === str(r.type).toLowerCase()) ?? "Rød";
  const abv = abvOrNull(r.abv);
  let drinkFrom = intOrNull(r.drink_from);
  let drinkTo = intOrNull(r.drink_to);
  if (drinkFrom && drinkTo && drinkFrom > drinkTo) [drinkFrom, drinkTo] = [drinkTo, drinkFrom];

  return {
    wine: {
      name: str(r.name) || "Ukendt vin",
      producer: str(r.producer),
      vintage: intOrNull(r.vintage),
      // Hvilken årgang drikkevinduet er udregnet ud fra, når etiketten ingen årgang har.
      assumedVintage: intOrNull(r.vintage) === null ? intOrNull(r.assumed_vintage) : null,
      type,
      country: str(r.country),
      region: str(r.region),
      grapes: str(r.grapes),
      description: str(r.description),
      drinkFrom,
      drinkTo,
      foodPairings: Array.isArray(r.food_pairings) ? r.food_pairings.map(str).filter(Boolean).slice(0, 8) : [],
      abv,
      natural: r.natural === true,
      alcoholFree: r.alcohol_free === true || (abv !== null && abv < 1),
      priceDk: (await verifyDanishOffers(r.offers, { producer: str(r.producer), name: str(r.name) })) ?? danishPrice(r.price_dk, sources, searched),
    },
    confidence: str(r.confidence) || "middel",
    uncertain: str(r.uncertain),
    sources: sources.slice(0, 8),
    searched,
    model,
  };
}

// ---------- match: hvilken af mine vine er det? ----------

type InvWine = {
  id: string;
  name?: string;
  producer?: string;
  vintage?: number | null;
  type?: string;
  region?: string;
  country?: string;
  grapes?: string;
  description?: string;
  foodPairings?: string[];
  drinkFrom?: number | null;
  drinkTo?: number | null;
  quantity?: number;
};

function wineList(wines: unknown): InvWine[] {
  if (!Array.isArray(wines)) throw new HttpError(400, "Vinlisten mangler.");
  return wines
    .filter((w) => w && typeof w.id === "string")
    .slice(0, 400);
}

// ---------- price: slå prisen op hos danske butikker for en vin i kælderen ----------

async function price(input: { wine?: { producer?: string; name?: string; vintage?: number | null; type?: string; region?: string } }, ctx: Ctx) {
  const w = input.wine ?? {};
  const label = [str(w.producer), str(w.name), w.vintage ? String(w.vintage) : "uden årgang"].filter(Boolean).join(" ");
  if (!str(w.name) && !str(w.producer)) throw new HttpError(400, "Vinen mangler navn.");
  const today = new Date().toLocaleDateString("da-DK", { day: "numeric", month: "long", year: "numeric" });
  const prompt = (retry: boolean) => `I dag er det ${today}. Find den aktuelle pris i danske vinbutikker for denne vin:
${label} (${str(w.type)}, ${str(w.region)})

Du kender IKKE de aktuelle priser – de ændrer sig hele tiden. Du SKAL bruge Google-søgning, før du svarer, fx:
- "${label} pris"
- "${[str(w.producer), str(w.name)].filter(Boolean).join(" ")} vin køb"
Svar aldrig ud fra hukommelsen.${retry ? "\nPriserne i dit forrige svar stod ikke på de sider, du linkede til. Søg igen og brug kun priser, der står på produktsiden." : ""}

Kig efter danske vinforhandlere og webshops. Brug samme årgang, hvis den findes. Findes den ikke, så angiv prisen for den nærmeste årgang af samme vin og skriv hvilken i vintage_found.
Medtag kun priser, du har fundet i søgningen, i kroner pr. 75 cl-flaske (ikke tilbud ved køb af flere). Er vinen slet ikke at finde i Danmark, så er price_dk null.

For hver pris skal du angive butikken og linket til produktsiden, som du fandt i søgningen.

Svar KUN med JSON: {"offers": [{"shop": "butik", "url": "link til produktsiden", "price": 229, "vintage": 2019}], "price_dk": {"min": 189, "max": 249} eller null, "vintage_found": 2019, "note": "kort dansk note, fx hvis prisen er for en anden årgang"}`;

  // Priserne tjekkes på butikkernes egne sider. Passede ingen af de foreslåede
  // priser, spørges der én gang mere.
  const ask = async (retry: boolean) => {
    // Lav tænkning: opgaven er enkel, og så bliver opslaget hurtigere og billigere.
    const g = await gemini([{ text: prompt(retry) }], { requireSearch: true, thinking: "low", ctx });
    const r = parseJson(g.text);
    const priceDk = (await verifyDanishOffers(r.offers, w)) ?? danishPrice(r.price_dk, g.sources, g.searched);
    return { r, priceDk };
  };
  let { r, priceDk } = await ask(false);
  if (!priceDk && Array.isArray(r.offers) && r.offers.length) ({ r, priceDk } = await ask(true));
  return {
    priceDk,
    vintageFound: intOrNull(r.vintage_found),
    note: str(r.note),
  };
}

async function match(input: { image: unknown; wines: unknown }, ctx: Ctx) {
  const wines = wineList(input.wines);
  if (!wines.length) throw new HttpError(422, "Du har ingen vine på lager.");
  const lines = wines
    .map((w) => `${w.id} | ${w.producer ?? ""} | ${w.name ?? ""} | ${w.vintage ?? "uden årgang"} | ${w.region ?? ""}`)
    .join("\n");
  const prompt = `Billedet viser en vinflaske, som ejeren er ved at drikke. Find den i ejerens beholdning herunder.
Aflæs etiketten (producent, navn, årgang) og sammenlign. Årgangen skal passe, hvis den kan ses.

Beholdning (id | producent | navn | årgang | region):
${lines}

Svar KUN med JSON:
{"id": "id fra listen eller null hvis ingen passer", "confidence": "høj | middel | lav",
 "label": "hvad du kan læse på etiketten, kort", "alternatives": ["op til 2 andre id'er der kunne passe"]}`;

  const { text } = await gemini([imagePart(input.image), { text: prompt }], { ctx });
  const r = parseJson(text);
  const ids = new Set(wines.map((w) => w.id));
  return {
    id: ids.has(r.id) ? r.id : null,
    confidence: str(r.confidence) || "middel",
    label: str(r.label),
    alternatives: (Array.isArray(r.alternatives) ? r.alternatives : []).filter((id: string) => ids.has(id) && id !== r.id).slice(0, 2),
  };
}

// ---------- pair: top 5 til en ret ----------

// Hvor meget haster det at drikke vinen? 0–10. null = ikke klar endnu.
function urgency(w: InvWine, year: number): { score: number | null; text: string } {
  const from = w.drinkFrom ?? null;
  const to = w.drinkTo ?? null;
  if (!from && !to) return { score: 3, text: "Intet drikkevindue angivet" };
  if (from && year < from) return { score: null, text: `Klar fra ${from}` };
  if (to && year > to) return { score: 8, text: "Over vinduet – drik den snart" };
  if (to && to - year <= 0) return { score: 10, text: "Sidste år i vinduet" };
  if (to && to - year <= 1) return { score: 8, text: `Bør drikkes inden udgangen af ${to}` };
  if (to && to - year <= 3) return { score: 5, text: `I vinduet til ${to}` };
  return { score: 2, text: to ? `I vinduet til ${to}` : "I vinduet" };
}

async function pair(input: { dish: unknown; wines: unknown; year?: unknown }, ctx: Ctx) {
  const dish = str(input.dish);
  if (!dish) throw new HttpError(400, "Skriv hvilken ret du skal have.");
  const year = intOrNull(input.year) ?? new Date().getFullYear();
  const inStock = wineList(input.wines).filter((w) => (w.quantity ?? 1) > 0);
  if (!inStock.length) throw new HttpError(422, "Du har ingen vine på lager.");

  const lines = inStock.map((w) =>
    `${w.id} | ${w.type ?? ""} | ${w.producer ?? ""} ${w.name ?? ""} ${w.vintage ?? ""} | ${w.region ?? ""} | ${w.grapes ?? ""} | ${w.description ?? ""} | passer til: ${(w.foodPairings ?? []).join(", ")}`
  ).join("\n");
  const prompt = `Du er sommelier. Retten er: "${dish}".
Vurdér hvor godt HVER vin herunder passer til retten på en skala 0–10 (10 = perfekt match).
Giv en kort dansk begrundelse (max 15 ord) for de bedste.

Vine (id | type | vin | region | druer | beskrivelse | madparring):
${lines}

Svar KUN med JSON: {"scores": [{"id": "...", "match": 0-10, "reason": "..."}]} – medtag alle vine.`;

  const { text } = await gemini([{ text: prompt }], { ctx });
  const r = parseJson(text);
  const scores = new Map<string, { match: number; reason: string }>();
  for (const s of Array.isArray(r.scores) ? r.scores : []) {
    if (s && typeof s.id === "string") {
      scores.set(s.id, { match: Math.max(0, Math.min(10, Number(s.match) || 0)), reason: str(s.reason) });
    }
  }

  // Samlet score: 70 % match, 30 % hvor meget det haster.
  // Vine der ikke er klar endnu, kommer kun med, hvis der ikke er nok andre.
  const all = inStock.map((w) => {
    const s = scores.get(w.id) ?? { match: 0, reason: "" };
    const u = urgency(w, year);
    const total = u.score === null ? s.match * 0.7 - 5 : s.match * 0.7 + u.score * 0.3;
    return {
      id: w.id, type: w.type, match: s.match, urgency: u.score, urgencyText: u.text,
      reason: s.reason, score: Math.round(total * 10) / 10,
    };
  }).sort((a, b) => b.score - a.score);
  const top = all.filter((x) => x.match >= 3).slice(0, 5);

  // Er der ingen hvidvin i top 5, foreslås den bedste hvidvin som nr. 6.
  const white = top.some((x) => x.type === "Hvid")
    ? null
    : all.find((x) => x.type === "Hvid" && x.urgency !== null) ?? all.find((x) => x.type === "Hvid") ?? null;

  return { dish, top, white };
}

// ---------- models: hvilke modeller kan nøglen bruge ----------

async function models() {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": GEMINI_API_KEY } });
  if (!res.ok) throw new HttpError(502, `Kunne ikke hente modeller: ${res.status}`);
  const data = await res.json();
  return {
    configured: MODELS,
    available: (data.models ?? [])
      .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m: { name: string }) => m.name.replace("models/", "")),
  };
}

// ---------- Server ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Kun POST." }, 405);
  try {
    const input = await req.json().catch(() => ({}));
    const user = await requireUser(req);
    const ctx: Ctx = { userId: user?.id ?? null, action: String(input.action ?? "") };
    // Advarsler om forbrug sendes med i hvert AI-svar, så appen kan vise dem.
    const withWarnings = (result: Record<string, unknown>) => json({ ...result, warnings: usageWarnings(ctx.usage) });
    switch (input.action) {
      case "identify": return withWarnings(await identify(input, ctx));
      case "match": return withWarnings(await match(input, ctx));
      case "pair": return withWarnings(await pair(input, ctx));
      case "price": return withWarnings(await price(input, ctx));
      case "usage": {
        const usage = await usageSummary();
        return json({ usage, warnings: usageWarnings(usage) });
      }
      case "models": return json(await models());
      default: return json({ error: "Ukendt handling." }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Der skete en fejl på serveren." }, 500);
  }
});
