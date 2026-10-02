// Wine Cellar – AI-funktion (Supabase Edge Function).
//
// Holder Gemini-nøglen hemmelig og kræver, at brugeren er logget ind.
// Al AI-logik ligger her, så AI-tjenesten kan skiftes uden at ændre appen.
//
// Handlinger (POST JSON med feltet "action"):
//   identify – { image }                 → oplysninger om vinen på etiketten
//   match    – { image, wines }          → hvilken vin i beholdningen billedet viser
//   pair     – { dish, wines, year }     → top 5 vine til retten
//   models   – {}                        → hvilke Gemini-modeller nøglen kan bruge

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Første model der virker bruges. Kan overstyres med hemmeligheden GEMINI_MODEL.
// (gemini-flash-latest er med i den gratis kvote; 3.8 Flash kræver betaling.)
const MODELS = (Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest,gemini-3.8-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
const API = "https://generativelanguage.googleapis.com/v1beta";
const WINE_TYPES = ["Rød", "Hvid", "Rosé", "Mousserende", "Dessert", "Hedvin"];

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

// ---------- Gemini ----------

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

// Med search=true forsøges Google-søgning først. Er søgning ikke med i kvoten
// (gratis udgave), svarer modellen i stedet ud fra sin egen viden.
async function gemini(parts: Part[], { search = false } = {}) {
  if (search) {
    try {
      return { ...(await callGemini(parts, true)), searched: true };
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 429)) throw err;
      console.warn("Google-søgning ikke tilgængelig – svarer uden søgning");
    }
  }
  return { ...(await callGemini(parts, false)), searched: false };
}

async function callGemini(parts: Part[], search: boolean) {
  if (!GEMINI_API_KEY) throw new HttpError(500, "GEMINI_API_KEY mangler i Supabase.");
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2 },
  };
  if (search) body.tools = [{ google_search: {} }];

  let lastError = "";
  for (const model of MODELS) {
    const res = await fetch(`${API}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? [])
        .map((p: { text?: string }) => p.text ?? "")
        .join("");
      const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
        .map((c: { web?: { uri?: string; title?: string } }) => c.web)
        .filter((w: unknown) => w)
        .map((w: { uri?: string; title?: string }) => ({ url: w.uri, title: w.title }));
      return { text, sources, model };
    }
    lastError = `${model}: ${res.status} ${(await res.text()).slice(0, 300)}`;
    console.error("Gemini-fejl", lastError);
    // Kvote opbrugt eller model ikke tilgængelig → prøv næste model.
    if (![400, 403, 404, 429, 500, 503].includes(res.status)) break;
  }
  if (lastError.includes(" 429 ")) {
    throw new HttpError(429, "AI'en er overbelastet eller dagens gratis kvote er brugt – prøv igen om lidt.");
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

// ---------- identify: genkend en ny vin ----------

async function identify(input: { image: unknown }) {
  const year = new Date().getFullYear();
  const prompt = `Du er en erfaren sommelier. Billedet viser en vinflaske eller en vinetiket.
1. Aflæs etiketten nøjagtigt: navn, producent, årgang, appellation/region og land.
2. Find druer, smagsprofil og hvornår netop denne vin og årgang bør drikkes. Søg på nettet (producentens side, anmeldelser, vinguider), hvis du har adgang til søgning – ellers brug din egen viden om producenten, området og årgangen.
3. Vurdér det ideelle drikkevindue for netop denne årgang som årstal. Det er nu år ${year}.

Svar KUN med ét JSON-objekt, uden forklaring før eller efter, med disse felter:
{
  "is_wine": true/false,            // false hvis billedet ikke viser en vin
  "name": "vinens navn uden producent og årgang, fx 'Barolo Cannubi'",
  "producer": "producent",
  "vintage": 2016,                  // årstal eller null hvis ikke angivet (fx NV champagne)
  "type": "en af: ${WINE_TYPES.join(", ")}",
  "country": "land på dansk",
  "region": "region/appellation",
  "grapes": "druer, kommasepareret",
  "description": "2–3 korte sætninger PÅ DANSK om vinens karakter og smag (krop, syre, tanniner, aromaer)",
  "drink_from": 2024,               // første år i det ideelle drikkevindue
  "drink_to": 2035,                 // sidste år i det ideelle drikkevindue
  "food_pairings": ["3–6 korte madtyper på dansk, fx 'lam', 'svampe', 'modne oste'"],
  "confidence": "høj | middel | lav", // hvor sikker du er på genkendelsen
  "uncertain": "kort dansk note om hvad der er usikkert, eller tom streng"
}`;

  const { text, sources, model, searched } = await gemini([imagePart(input.image), { text: prompt }], { search: true });
  const r = parseJson(text);
  if (r.is_wine === false) throw new HttpError(422, "Jeg kan ikke se en vinetiket på billedet. Prøv igen tættere på etiketten.");

  const type = WINE_TYPES.find((t) => t.toLowerCase() === str(r.type).toLowerCase()) ?? "Rød";
  let drinkFrom = intOrNull(r.drink_from);
  let drinkTo = intOrNull(r.drink_to);
  if (drinkFrom && drinkTo && drinkFrom > drinkTo) [drinkFrom, drinkTo] = [drinkTo, drinkFrom];

  return {
    wine: {
      name: str(r.name) || "Ukendt vin",
      producer: str(r.producer),
      vintage: intOrNull(r.vintage),
      type,
      country: str(r.country),
      region: str(r.region),
      grapes: str(r.grapes),
      description: str(r.description),
      drinkFrom,
      drinkTo,
      foodPairings: Array.isArray(r.food_pairings) ? r.food_pairings.map(str).filter(Boolean).slice(0, 8) : [],
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

async function match(input: { image: unknown; wines: unknown }) {
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

  const { text } = await gemini([imagePart(input.image), { text: prompt }]);
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

async function pair(input: { dish: unknown; wines: unknown; year?: unknown }) {
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

  const { text } = await gemini([{ text: prompt }]);
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
    await requireUser(req);
    switch (input.action) {
      case "identify": return json(await identify(input));
      case "match": return json(await match(input));
      case "pair": return json(await pair(input));
      case "models": return json(await models());      default: return json({ error: "Ukendt handling." }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Der skete en fejl på serveren." }, 500);
  }
});
