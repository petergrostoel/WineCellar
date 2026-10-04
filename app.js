// Wine Cellar – vinkælder-app.
// Data gemmes online i Supabase (bag login) og holdes også som lokal kopi,
// så kælderen kan ses offline. AI-funktionerne (foto, madforslag) kræver net.

const CACHE_KEY = "wine-cellar.v1";            // lokal kopi af vinene
const PENDING_KEY = "wine-cellar.pending.v1";  // ændringer der mangler at blive sendt op
const OWNER_KEY = "wine-cellar.owner.v1";      // hvilken bruger den lokale kopi tilhører
const TASTINGS_KEY = "wine-cellar.tastings.v1";
const WINE_TYPES = ["Rød", "Hvid", "Rosé", "Mousserende", "Dessert", "Hedvin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const { supabaseUrl, supabaseKey } = window.WINE_CELLAR_CONFIG;
const db = supabase.createClient(supabaseUrl, supabaseKey);

let user = null;
let wines = readJson(CACHE_KEY, []);
let tastings = readJson(TASTINGS_KEY, []);
// upserts: { id: revision } – revisionen sikrer, at en ændring lavet mens
// vi synkroniserer ikke bliver glemt.
let pending = readJson(PENDING_KEY, null) ?? {
  upserts: Object.fromEntries(wines.map((w) => [w.id, 1])),
  deletes: [],
};
let rev = Date.now();

const thisYear = () => new Date().getFullYear();

// ============================================================
// Lokal lagring
// ============================================================

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function persist() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(wines));
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    localStorage.setItem(TASTINGS_KEY, JSON.stringify(tastings));
  } catch (err) {
    console.error("Kunne ikke gemme lokalt", err);
  }
}

function markChanged(id) {
  pending.upserts[id] = ++rev;
  pending.deletes = pending.deletes.filter((d) => d !== id);
}

function markDeleted(id) {
  delete pending.upserts[id];
  if (!pending.deletes.includes(id)) pending.deletes.push(id);
}

function hasPending() {
  return pending.deletes.length > 0 || Object.keys(pending.upserts).length > 0;
}

function save() {
  persist();
  render();
  sync();
}

// ============================================================
// Synkronisering med Supabase
// ============================================================

function toRow(w) {
  return {
    id: w.id,
    name: w.name,
    producer: w.producer || null,
    type: w.type || null,
    vintage: w.vintage ?? null,
    country: w.country || null,
    region: w.region || null,
    grapes: w.grapes || null,
    quantity: w.quantity ?? 0,
    price: w.price ?? null,
    drink_from: w.drinkFrom ?? null,
    drink_to: w.drinkTo ?? null,
    location: w.location || null,
    notes: w.notes || null,
    description: w.description || null,
    food_pairings: w.foodPairings ?? [],
    image_path: w.imagePath || null,
    ai_sources: w.aiSources ?? null,
  };
}

function fromRow(r) {
  return {
    id: r.id,
    name: r.name,
    producer: r.producer ?? "",
    type: r.type ?? "Rød",
    vintage: r.vintage,
    country: r.country ?? "",
    region: r.region ?? "",
    grapes: r.grapes ?? "",
    quantity: r.quantity ?? 0,
    price: r.price == null ? null : Number(r.price),
    drinkFrom: r.drink_from,
    drinkTo: r.drink_to,
    location: r.location ?? "",
    notes: r.notes ?? "",
    description: r.description ?? "",
    foodPairings: r.food_pairings ?? [],
    imagePath: r.image_path ?? "",
    aiSources: r.ai_sources ?? null,
    added: r.created_at,
  };
}

function tastingFromRow(r) {
  return { id: r.id, wineId: r.wine_id, drunkAt: r.drunk_at, rating: r.rating, notes: r.notes ?? "" };
}

function setSync(state, text) {
  const el = $("#sync-status");
  el.className = "sync " + state;
  el.textContent = text;
}

let syncing = false;
let syncAgain = false;

async function sync() {
  if (!user) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  setSync("pending", "⟳ Gemmer…");
  try {
    if (pending.deletes.length) {
      const ids = [...pending.deletes];
      const { error } = await db.from("wines").delete().in("id", ids);
      if (error) throw error;
      pending.deletes = pending.deletes.filter((id) => !ids.includes(id));
      persist();
    }

    const sent = { ...pending.upserts };
    const rows = wines.filter((w) => w.id in sent).map(toRow);
    if (rows.length) {
      const { error } = await db.from("wines").upsert(rows);
      if (error) throw error;
    }
    for (const [id, r] of Object.entries(sent)) {
      if (pending.upserts[id] === r) delete pending.upserts[id];
    }
    persist();

    // Hent den samlede kælder (fx ændringer lavet på en anden enhed).
    const [w, t] = await Promise.all([
      db.from("wines").select("*"),
      db.from("tastings").select("*").order("drunk_at", { ascending: false }),
    ]);
    if (w.error) throw w.error;
    if (t.error) throw t.error;
    if (!hasPending()) wines = w.data.map(fromRow);
    tastings = t.data.map(tastingFromRow);
    persist();
    render();
    setSync("ok", "✓ Gemt");
  } catch (err) {
    console.error("Synkronisering fejlede", err);
    if (navigator.onLine) setSync("error", "⚠ Ikke gemt online");
    else setSync("pending", "Offline");
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      sync();
    }
  }
}

// Vent til en bestemt vin er gemt online (fx før en smagning knyttes til den).
async function flushWine(id) {
  for (let i = 0; i < 30 && pending.upserts[id]; i++) {
    if (syncing) await new Promise((r) => setTimeout(r, 300));
    else await sync();
  }
  if (pending.upserts[id]) throw new Error("Vinen kunne ikke gemmes online endnu.");
}

window.addEventListener("online", sync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sync();
});
setInterval(() => {
  if (hasPending()) sync();
}, 30000);

// ============================================================
// AI-funktion og billeder
// ============================================================

async function ai(action, body) {
  if (!navigator.onLine) throw new Error("Du er offline. AI-funktionerne kræver internet.");
  const { data, error } = await db.functions.invoke("wine-ai", { body: { action, ...body } });
  if (error) {
    let msg = "AI'en svarede ikke. Prøv igen.";
    try {
      msg = (await error.context.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return data;
}

// Gør billedet mindre (hurtigere upload og AI) og returnér JPEG.
function prepareImage(file, max = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      canvas.toBlob((blob) => resolve({ blob, dataUrl }), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Billedet kunne ikke læses."));
    };
    img.src = url;
  });
}

async function uploadLabel(wineId, blob) {
  const path = `${user.id}/${wineId}.jpg`;
  const { error } = await db.storage.from("labels").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
  if (error) throw error;
  imageUrls.delete(path);
  return path;
}

// Signerede URL'er til private billeder, gemt i hukommelsen.
const imageUrls = new Map();

async function loadImageUrls(paths) {
  const missing = [...new Set(paths.filter((p) => p && !imageUrls.has(p)))];
  if (!missing.length || !navigator.onLine) return;
  const { data, error } = await db.storage.from("labels").createSignedUrls(missing, 60 * 60 * 24);
  if (error) return console.warn("Kunne ikke hente billeder", error);
  for (const d of data) if (d.signedUrl) imageUrls.set(d.path, d.signedUrl);
}

function applyThumbs(root = document) {
  for (const el of $$("[data-img]", root)) {
    const url = imageUrls.get(el.dataset.img);
    if (url) {
      if (el.tagName === "IMG") el.src = url;
      else {
        el.style.backgroundImage = `url("${url}")`;
        el.textContent = "";
      }
    }
  }
}

async function refreshThumbs(root = document) {
  const paths = $$("[data-img]", root).map((el) => el.dataset.img);
  applyThumbs(root);
  await loadImageUrls(paths);
  applyThumbs(root);
}

// Åbn kameraet og returnér det valgte billede.
function takePhoto() {
  return new Promise((resolve) => {
    const input = $("#camera");
    input.value = "";
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ============================================================
// Drikkevindue
// ============================================================

// rød = ikke klar, gul = snart klar / sidste år, grøn = ideelt, grå = over vinduet
function windowStatus(w, year = thisYear()) {
  const from = w.drinkFrom, to = w.drinkTo;
  if (!from && !to) return { key: "none", label: "Intet drikkevindue" };
  if (from && year < from - 1) return { key: "red", label: `Ikke klar – fra ${from}` };
  if (from && year === from - 1) return { key: "light", label: `Snart klar – fra ${from}` };
  if (to && year > to) return { key: "grey", label: `Over vinduet (til ${to})` };
  if (to && year === to) return { key: "yellow", label: "Sidste år i vinduet – drik nu" };
  return { key: "green", label: to ? `Ideel – drik til ${to}` : "Ideel nu" };
}

function windowText(w) {
  if (w.drinkFrom && w.drinkTo) return `${w.drinkFrom}–${w.drinkTo}`;
  if (w.drinkFrom) return `fra ${w.drinkFrom}`;
  if (w.drinkTo) return `til ${w.drinkTo}`;
  return "ukendt";
}

// Lavere = skal drikkes før. Bruges til sortering.
function urgencyRank(w) {
  const s = windowStatus(w).key;
  const order = { grey: 0, yellow: 1, green: 2, light: 3, red: 4, none: 5 };
  const base = order[s];
  return base * 10000 + (w.drinkTo ?? 9999);
}

function statusHtml(w, big = false) {
  const s = windowStatus(w);
  return `<span class="status${big ? " big" : ""}"><span class="dot ${s.key}"></span>${escapeHtml(s.label)}</span>`;
}

// ============================================================
// Login
// ============================================================

function showView(loggedIn) {
  $("#auth-view").hidden = loggedIn;
  $("#app-view").hidden = !loggedIn;
}

function authMessage(text, kind = "") {
  const el = $("#auth-msg");
  el.textContent = text;
  el.className = "auth-msg " + kind;
}

function translateAuthError(err) {
  const m = err?.message || String(err);
  if (/invalid login credentials/i.test(m)) return "Forkert e-mail eller adgangskode.";
  if (/email not confirmed/i.test(m)) return "Du skal først bekræfte din e-mail via linket, vi har sendt dig.";
  if (/already registered/i.test(m)) return "Der findes allerede en konto med den e-mail. Log ind i stedet.";
  if (/password should be at least/i.test(m)) return "Adgangskoden skal være på mindst 8 tegn.";
  if (/rate limit/i.test(m)) return "For mange forsøg – vent lidt og prøv igen.";
  if (/signups not allowed/i.test(m)) return "Det er ikke muligt at oprette nye konti.";
  if (/fetch|network/i.test(m)) return "Ingen forbindelse – tjek dit internet.";
  return m;
}

function onSignedIn(newUser) {
  // Lokal kopi fra en anden bruger må ikke blandes ind.
  const owner = localStorage.getItem(OWNER_KEY);
  if (owner && owner !== newUser.id) {
    wines = [];
    tastings = [];
    pending = { upserts: {}, deletes: [] };
  }
  try {
    localStorage.setItem(OWNER_KEY, newUser.id);
  } catch {}
  user = newUser;
  persist();
  showView(true);
  render();
  sync();
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || "signin";
  const email = e.target.email.value.trim();
  const password = e.target.password.value;
  const buttons = $$("button", e.target);
  buttons.forEach((b) => (b.disabled = true));
  authMessage(mode === "signup" ? "Opretter konto…" : "Logger ind…");
  try {
    if (mode === "signup") {
      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      if (data.session) return; // onAuthStateChange viser appen
      authMessage("Konto oprettet! Tjek din e-mail og klik på bekræftelseslinket. Kom derefter tilbage og log ind her.", "ok");
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) throw error;
      authMessage("");
    }
  } catch (err) {
    authMessage(translateAuthError(err), "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

// Konto: vis e-mail, skift adgangskode og log ud.
$("#account-btn").addEventListener("click", () => {
  openSheet(`
    <h2>Konto</h2>
    <p class="sub">Logget ind som <strong>${escapeHtml(user?.email ?? "")}</strong></p>
    <div class="section-label">Skift adgangskode</div>
    <form id="password-form" class="stack" autocomplete="on">
      <input type="email" name="username" value="${escapeHtml(user?.email ?? "")}" autocomplete="username" hidden>
      <label>Ny adgangskode<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
      <label>Gentag ny adgangskode<input type="password" name="repeat" required minlength="8" autocomplete="new-password"></label>
      <p id="password-msg" class="notice" hidden></p>
      <button type="submit" class="primary" id="password-save">Skift adgangskode</button>
    </form>
    <div class="section-label">Log ud</div>
    <button type="button" id="logout-btn" style="width:100%">Log ud</button>`);

  const form = $("#password-form");
  const msg = (text, kind) => {
    const el = $("#password-msg");
    el.hidden = false;
    el.className = "notice " + kind;
    el.textContent = text;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = form.elements.password.value;
    if (password !== form.elements.repeat.value) return msg("De to adgangskoder er ikke ens.", "error");
    const btn = $("#password-save");
    btn.disabled = true;
    btn.textContent = "Gemmer…";
    try {
      const { error } = await db.auth.updateUser({ password });
      if (error) throw error;
      form.reset();
      msg("Adgangskoden er skiftet. Brug den nye næste gang du logger ind.", "ok");
    } catch (err) {
      const m = err?.message || String(err);
      msg(/different from the old/i.test(m) ? "Den nye adgangskode skal være forskellig fra den gamle."
        : /at least|weak/i.test(m) ? "Adgangskoden er for svag – brug mindst 8 tegn."
        : /fetch|network/i.test(m) ? "Ingen forbindelse – prøv igen, når du har net."
        : m, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Skift adgangskode";
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    if (hasPending() && !confirm("Nogle ændringer er endnu ikke gemt online og går tabt, hvis du logger ud. Log ud alligevel?")) return;
    closeSheet();
    await db.auth.signOut();
  });
});

db.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    if (user?.id !== session.user.id) onSignedIn(session.user);
  } else if (event === "SIGNED_OUT") {
    user = null;
    wines = [];
    tastings = [];
    pending = { upserts: {}, deletes: [] };
    persist();
    try {
      localStorage.removeItem(OWNER_KEY);
    } catch {}
    showView(false);
  }
});

// ============================================================
// Hjælpere
// ============================================================

function num(v) {
  return v === "" || v == null ? null : Number(v);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function wineTitle(w) {
  return [w.producer, w.name].filter(Boolean).join(" – ") || "Ukendt vin";
}

function wineMeta(w) {
  return [w.vintage || "Uden årgang", w.type, [w.region, w.country].filter(Boolean).join(", ")]
    .filter(Boolean).join(" · ");
}

function thumbHtml(w) {
  return `<div class="thumb" ${w.imagePath ? `data-img="${escapeHtml(w.imagePath)}"` : ""}>🍷</div>`;
}

function starsHtml(n) {
  if (!n) return "";
  return `<span class="stars-static" aria-label="${n} af 5 stjerner">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric" });
}

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

const inStock = () => wines.filter((w) => w.quantity > 0);

// ============================================================
// Visning: faner
// ============================================================

let currentTab = "cellar";

$$(".tabbar button").forEach((btn) =>
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    $$(".tabbar button").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".tab").forEach((t) => (t.hidden = t.id !== `tab-${currentTab}`));
    window.scrollTo(0, 0);
    render();
  }));

function render() {
  if (!user) return;
  renderStats();
  if (currentTab === "cellar") renderCellar();
  if (currentTab === "timeline") renderTimeline();
  if (currentTab === "history") renderHistory();
}

function renderStats() {
  const stock = inStock();
  const bottles = stock.reduce((s, w) => s + w.quantity, 0);
  const ready = stock.filter((w) => windowStatus(w).key === "green").length;
  const soon = stock.filter((w) => ["yellow", "grey"].includes(windowStatus(w).key)).length;
  $("#stats").innerHTML = `
    <span><strong>${bottles}</strong> flasker</span>
    <span><strong>${stock.length}</strong> vine</span>
    <span><span class="dot green" style="display:inline-block"></span> <strong>${ready}</strong> klar</span>
    <span><span class="dot yellow" style="display:inline-block"></span> <strong>${soon}</strong> haster</span>`;
}

function wineItemHtml(w) {
  return `
    <li class="wine-item" data-id="${w.id}">
      ${thumbHtml(w)}
      <div>
        <div class="title">${escapeHtml(wineTitle(w))}</div>
        <div class="meta">${escapeHtml(wineMeta(w))}</div>
        ${statusHtml(w)}
      </div>
      <div class="qty-badge">${w.quantity}<small>fl.</small></div>
    </li>`;
}

function renderCellar() {
  const year = thisYear();
  const stock = inStock();

  // Skal snart drikkes: over vinduet eller vinduet slutter i år/næste år.
  const soon = stock
    .filter((w) => w.drinkTo && w.drinkTo <= year + 1)
    .sort((a, b) => a.drinkTo - b.drinkTo);
  $("#soon").hidden = soon.length === 0;
  $("#soon-list").innerHTML = soon.map(wineItemHtml).join("");

  const q = $("#search").value.trim().toLowerCase();
  const type = $("#filter-type").value;
  const sort = $("#sort").value;
  const visible = stock
    .filter((w) => !type || w.type === type)
    .filter((w) => !q || [w.name, w.producer, w.country, w.region, w.grapes, w.location, w.description]
      .some((f) => (f || "").toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === "urgency") return urgencyRank(a) - urgencyRank(b);
      if (sort === "name") return wineTitle(a).localeCompare(wineTitle(b), "da");
      if (sort === "quantity") return b.quantity - a.quantity;
      return (a.vintage ?? 9999) - (b.vintage ?? 9999);
    });

  $("#wine-list").innerHTML = visible.map(wineItemHtml).join("");
  $("#empty").hidden = visible.length > 0;
  $("#empty").textContent = stock.length
    ? "Ingen vine matcher din søgning."
    : "Din kælder er tom. Tryk på 📷 Ny vin og fotografér din første flaske.";
  refreshThumbs($("#tab-cellar"));
}

["#search", "#filter-type", "#sort"].forEach((sel) => $(sel).addEventListener("input", renderCellar));

document.addEventListener("click", (e) => {
  const item = e.target.closest(".wine-item[data-id], .tl-row[data-id]");
  if (item && !item.closest("#sheet")) openDetail(item.dataset.id);
});

// ============================================================
// Tidslinje
// ============================================================

function renderTimeline() {
  renderAreaChart();
  renderWindows();
  renderExpired();
}

// --- Kurve: drikkeklare flasker pr. år (grøn), med gule og røde ovenpå ---

const AREA_SERIES = [
  ["green", "Drikkeklar"],
  ["yellow", "Sidste år i vinduet"],
  ["light", "Snart klar"],
  ["red", "Ikke klar endnu"],
];

function yearCounts(stock, y) {
  const c = { green: 0, yellow: 0, light: 0, red: 0 };
  for (const w of stock) {
    const k = windowStatus(w, y).key;
    if (k in c) c[k] += w.quantity;
  }
  return c;
}

function renderAreaChart() {
  const el = $("#area-chart");
  const year = thisYear();
  const stock = inStock().filter((w) => w.drinkFrom || w.drinkTo);
  $("#area-legend").innerHTML = AREA_SERIES
    .map(([k, t]) => `<span><span class="dot ${k}"></span>${t}</span>`).join("");
  if (!stock.length) {
    el.innerHTML = `<p class="empty">Ingen vine med drikkevindue endnu.</p>`;
    return;
  }

  const lastYear = Math.min(year + 30, Math.max(year + 8, ...stock.map((w) => (w.drinkTo ?? year) + 1)));
  const years = [];
  for (let y = year; y <= lastYear; y++) years.push(y);
  const data = years.map((y) => ({ year: y, ...yearCounts(stock, y) }));

  const W = Math.max(280, el.clientWidth || 340);
  const H = 190;
  const m = { l: 30, r: 10, t: 10, b: 24 };
  const maxTotal = Math.max(1, ...data.map((d) => d.green + d.yellow + d.light + d.red));
  const yMax = maxTotal <= 4 ? 4 : Math.ceil(maxTotal / 4) * 4;
  const stepX = (W - m.l - m.r) / (years.length - 1);
  const x = (i) => m.l + i * stepX;
  const yPx = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);

  // Lag: grøn fra 0, gul oven på grøn, rød øverst.
  const band = (lo, hi) => {
    const top = data.map((d, i) => `${x(i).toFixed(1)},${yPx(hi(d)).toFixed(1)}`);
    const bottom = data.map((d, i) => `${x(i).toFixed(1)},${yPx(lo(d)).toFixed(1)}`).reverse();
    return `M${top.join("L")}L${bottom.join("L")}Z`;
  };
  const g = (d) => d.green;
  const gy = (d) => d.green + d.yellow;
  const gyl = (d) => d.green + d.yellow + d.light;
  const all = (d) => d.green + d.yellow + d.light + d.red;

  const yTicks = [0, yMax / 2, yMax];
  const labelEvery = Math.ceil(years.length / 7);

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Drikkeklare flasker pr. år fra ${year} til ${lastYear}">
      ${yTicks.map((v) => `
        <line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${yPx(v)}" y2="${yPx(v)}"></line>
        <text class="axis-text" x="${m.l - 6}" y="${yPx(v) + 4}" text-anchor="end">${v}</text>`).join("")}
      <path class="area-red" d="${band(gyl, all)}"></path>
      <path class="area-light" d="${band(gy, gyl)}"></path>
      <path class="area-yellow" d="${band(g, gy)}"></path>
      <path class="area-green" d="${band(() => 0, g)}"></path>
      <polyline class="line-green" points="${data.map((d, i) => `${x(i).toFixed(1)},${yPx(d.green).toFixed(1)}`).join(" ")}"></polyline>
      <line class="base-line" x1="${m.l}" x2="${W - m.r}" y1="${yPx(0)}" y2="${yPx(0)}"></line>
      ${years.map((y, i) => i % labelEvery === 0 ? `<text class="axis-text" x="${x(i)}" y="${H - 6}" text-anchor="middle">${y}</text>` : "").join("")}
      <line class="cursor" id="area-cursor" y1="${m.t}" y2="${yPx(0)}" visibility="hidden"></line>
      <circle class="cursor-dot" id="area-dot" r="5" visibility="hidden"></circle>
      <rect x="${m.l - 10}" y="0" width="${W - m.l - m.r + 20}" height="${H}" fill="transparent" id="area-hit"></rect>
    </svg>
    <div class="area-tip" id="area-tip" hidden></div>`;

  // Hover: vis tal for nærmeste år. Tryk: vælg året og filtrér listen nedenunder.
  const svg = $("svg", el);
  const indexAt = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(years.length - 1, Math.round((px - m.l) / stepX)));
  };
  const showIndex = (i) => {
    const rect = svg.getBoundingClientRect();
    const d = data[i];
    $("#area-cursor").setAttribute("x1", x(i));
    $("#area-cursor").setAttribute("x2", x(i));
    $("#area-cursor").setAttribute("visibility", "visible");
    $("#area-dot").setAttribute("cx", x(i));
    $("#area-dot").setAttribute("cy", yPx(d.green));
    $("#area-dot").setAttribute("visibility", "visible");
    const tip = $("#area-tip");
    tip.innerHTML = `<strong>${d.year}</strong>` + AREA_SERIES
      .map(([k, t]) => `<div><span class="dot ${k}"></span>${t}: <b>${d[k]}</b> fl.</div>`).join("");
    tip.hidden = false;
    const scale = rect.width / W;
    const left = x(i) * scale;
    const tipW = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, left - tipW / 2), rect.width - tipW)}px`;
    tip.style.top = `${-tip.offsetHeight - 6}px`;
  };
  const hide = () => {
    $("#area-tip").hidden = true;
    $("#area-cursor").setAttribute("visibility", "hidden");
    $("#area-dot").setAttribute("visibility", "hidden");
  };
  const selectedIndex = () => years.indexOf(selectedYear);
  const hit = $("#area-hit");
  hit.addEventListener("pointermove", (e) => showIndex(indexAt(e)));
  hit.addEventListener("pointerdown", (e) => {
    const i = indexAt(e);
    showIndex(i);
    selectedYear = years[i] === year ? null : years[i];
    renderWindows();
  });
  hit.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    // Ved hover tilbage til det valgte år (eller skjul, hvis intet er valgt).
    if (selectedIndex() >= 0) showIndex(selectedIndex());
    else hide();
  });
  if (selectedIndex() >= 0) requestAnimationFrame(() => showIndex(selectedIndex()));
}

// Valgt år i kurven (null = i år). Listen over drikkevinduer følger det.
let selectedYear = null;

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (currentTab === "timeline") renderAreaChart(); }, 150);
});

// --- Drikkevinduer pr. vin, fra i år og frem ---

const STATUS_NAMES = {
  green: "Ideel",
  yellow: "Sidste år i vinduet",
  light: "Snart klar",
  red: "Ikke klar",
  grey: "Over vinduet",
  none: "Ukendt",
};

function renderWindows() {
  const now = thisYear();
  // Alt nedenfor beregnes for det valgte år (standard: i år).
  const year = selectedYear ?? now;
  const withWindow = inStock().filter((w) => w.drinkFrom || w.drinkTo);
  const stock = withWindow.filter((w) => windowStatus(w, year).key !== "grey");
  const without = inStock().filter((w) => !w.drinkFrom && !w.drinkTo);

  const filterBar = selectedYear ? `
    <div class="tl-filter">
      <span>Viser <strong>${year}</strong> · ${stock.length} vine</span>
      <button type="button" class="small" id="tl-reset">Vis i år</button>
    </div>` : "";

  if (!stock.length) {
    $("#timeline").innerHTML = filterBar + `<p class="empty">${withWindow.length
      ? `Ingen vine er inden for eller før deres drikkevindue i ${year}.`
      : "Ingen vine med drikkevindue endnu."}</p>`;
    $("#tl-reset")?.addEventListener("click", resetSelectedYear);
    return;
  }

  // Klar nu: sorteret efter hvor stor en del af vinduet der er tilbage –
  // tættest på at udløbe øverst, lige blevet klar nederst.
  // Derefter dem der endnu ikke er klar, efter hvornår de bliver det.
  const ready = (w) => !w.drinkFrom || w.drinkFrom <= year;
  const leftShare = (w) => {
    if (!w.drinkTo) return 1;
    const from = w.drinkFrom ?? year;
    return (w.drinkTo - year + 1) / (w.drinkTo - from + 1);
  };
  const sorted = [
    ...stock.filter(ready).sort((a, b) =>
      leftShare(a) - leftShare(b) || (a.drinkTo ?? 9999) - (b.drinkTo ?? 9999)),
    ...stock.filter((w) => !ready(w)).sort((a, b) => a.drinkFrom - b.drinkFrom || (a.drinkTo ?? 9999) - (b.drinkTo ?? 9999)),
  ];

  // Akse fra i dag til og med det sidste år, hvor en vin i kælderen er i sit vindue.
  const minY = now;
  const maxY = Math.min(now + 30, Math.max(now + 6, year + 2, ...withWindow.map((w) => (w.drinkTo ?? now) + 1)));
  const span = maxY - minY;
  const pos = (y) => ((y - minY) / span) * 100;
  const step = span > 20 ? 10 : 5;
  const ticks = [];
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) ticks.push(y);
  const grid = ticks.map((y) => `<span class="tl-grid" style="left:${pos(y)}%"></span>`).join("")
    + `<span class="tl-now" style="left:${pos(now + 0.5)}%"></span>`
    + (year !== now ? `<span class="tl-sel" style="left:${pos(year + 0.5)}%"></span>` : "");

  // Livscyklus: bjælken farves år for år efter vinens status det år
  // (rød → gul → grøn → gul → grå), samlet i sammenhængende stykker.
  const lifecycle = (w) => {
    const runs = [];
    for (let y = minY; y < maxY; y++) {
      const key = windowStatus(w, y).key;
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.to = y + 1;
      else runs.push({ key, from: y, to: y + 1 });
    }
    return runs.map((r, i) => {
      const ends = [i === 0 ? "first" : "", i === runs.length - 1 ? "last" : ""].join(" ");
      const label = `${r.from}${r.to - 1 > r.from ? "–" + (r.to - 1) : ""}: ${STATUS_NAMES[r.key]}`;
      return `<span class="tl-seg ${r.key} ${ends}" style="left:${pos(r.from)}%;width:${pos(r.to) - pos(r.from)}%" title="${label}"></span>`;
    }).join("");
  };

  const rows = sorted.map((w) => {
    const s = windowStatus(w, year);
    return `
      <div class="tl-row" data-id="${w.id}" title="${escapeHtml(wineTitle(w))}: ${windowText(w)} – ${escapeHtml(s.label)}">
        <div class="tl-name"><span><span class="dot ${s.key}" style="display:inline-block"></span> ${escapeHtml(wineTitle(w))} ${w.vintage ?? ""}</span><small>${windowText(w)} · ${w.quantity} fl.</small></div>
        <div class="tl-track">${grid}${lifecycle(w)}</div>
      </div>`;
  }).join("");

  const legend = `<div class="legend">${["green", "yellow", "light", "red", "grey"]
    .map((k) => `<span><span class="dot ${k}"></span>${STATUS_NAMES[k]}</span>`).join("")}</div>`;

  const axis = `<div class="tl-axis">${ticks.map((y) => `<span style="left:${pos(y)}%">${y}</span>`).join("")}</div>`;
  $("#timeline").innerHTML = filterBar + legend + axis + rows +
    (without.length ? `<p class="muted small-text" style="margin-top:12px">Uden drikkevindue: ${without.map((w) => escapeHtml(wineTitle(w))).join(", ")}</p>` : "");
  $("#tl-reset")?.addEventListener("click", resetSelectedYear);
}

function resetSelectedYear() {
  selectedYear = null;
  renderAreaChart();
  renderWindows();
}

// --- Over vinduet: vine der bør tjekkes eller kasseres ---

const expiredWines = () => inStock()
  .filter((w) => windowStatus(w).key === "grey")
  .sort((a, b) => a.drinkTo - b.drinkTo);

function renderExpired() {
  const list = expiredWines();
  $("#expired-empty").hidden = list.length > 0;
  $("#expired-actions").hidden = list.length === 0;
  $("#expired-list").innerHTML = list.map((w) => `
    <li class="wine-item" data-id="${w.id}">
      ${thumbHtml(w)}
      <div>
        <div class="title">${escapeHtml(wineTitle(w))} ${w.vintage ?? ""}</div>
        <div class="meta">Vindue til ${w.drinkTo} · ${thisYear() - w.drinkTo} år over${w.location ? ` · 📍 ${escapeHtml(w.location)}` : ""}</div>
        <div class="expired-actions" style="margin-top:6px">
          <button type="button" class="small danger" data-discard="${w.id}">Kassér ${w.quantity} fl.</button>
        </div>
      </div>
      <div class="qty-badge">${w.quantity}<small>fl.</small></div>
    </li>`).join("");
  refreshThumbs($("#expired-list"));
}

$("#expired-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-discard]");
  if (!btn) return;
  e.stopPropagation();
  const w = wines.find((x) => x.id === btn.dataset.discard);
  if (!w || !confirm(`Kassér ${w.quantity} fl. ${wineTitle(w)} ${w.vintage ?? ""}? De fjernes fra beholdningen.`)) return;
  w.quantity = 0;
  markChanged(w.id);
  save();
  toast("Kasseret og fjernet fra beholdningen");
});

$("#expired-share").addEventListener("click", async () => {
  const lines = expiredWines().map((w) =>
    `• ${wineTitle(w)} ${w.vintage ?? ""} – ${w.quantity} fl. – vindue til ${w.drinkTo}${w.location ? ` – ${w.location}` : ""}`);
  const text = `Vine over drikkevinduet (${new Date().toLocaleDateString("da-DK")}):\n${lines.join("\n")}`;
  try {
    if (navigator.share) await navigator.share({ title: "Vine over drikkevinduet", text });
    else {
      await navigator.clipboard.writeText(text);
      toast("Listen er kopieret");
    }
  } catch (err) {
    if (err?.name !== "AbortError") toast("Listen kunne ikke deles");
  }
});


// ============================================================
// Historik (drukket)
// ============================================================

function renderHistory() {
  const byId = new Map(wines.map((w) => [w.id, w]));
  const items = tastings.filter((t) => byId.has(t.wineId));
  $("#history-empty").hidden = items.length > 0;
  $("#history-list").innerHTML = items.map((t) => {
    const w = byId.get(t.wineId);
    return `
      <li class="wine-item" data-id="${w.id}">
        ${thumbHtml(w)}
        <div>
          <div class="title">${escapeHtml(wineTitle(w))} ${w.vintage ?? ""}</div>
          <div class="meta">${formatDate(t.drunkAt)} ${starsHtml(t.rating)}</div>
          ${t.notes ? `<div class="notes">${escapeHtml(t.notes)}</div>` : ""}
        </div>
      </li>`;
  }).join("");
  refreshThumbs($("#tab-history"));
}

// ============================================================
// Ark (dialog)
// ============================================================

let sheetToken = 0; // så et svar fra AI ikke vises i et ark, der er lukket

function openSheet(html) {
  $("#sheet-body").onclick = null;
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  $(".sheet-panel").scrollTop = 0;
  refreshThumbs($("#sheet"));
  return ++sheetToken;
}

function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
  sheetToken++;
}

$("#sheet").addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeSheet();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
});

function loadingHtml(text, sub = "") {
  return `<div class="loading"><div class="spinner"></div><strong>${escapeHtml(text)}</strong>${sub ? `<p class="muted">${escapeHtml(sub)}</p>` : ""}</div>`;
}

function errorHtml(title, msg, retryLabel = "Prøv igen") {
  return `
    <h2>${escapeHtml(title)}</h2>
    <div class="notice error">${escapeHtml(msg)}</div>
    <div class="actions">
      <button type="button" class="primary" data-act="retry">${escapeHtml(retryLabel)}</button>
      <button type="button" data-close>Luk</button>
    </div>`;
}

// ============================================================
// Detaljer om en vin
// ============================================================

function openDetail(id) {
  const w = wines.find((x) => x.id === id);
  if (!w) return;
  const wineTastings = tastings.filter((t) => t.wineId === id);
  const facts = [
    ["Årgang", w.vintage || "Uden årgang"],
    ["Type", w.type],
    ["Region", [w.region, w.country].filter(Boolean).join(", ")],
    ["Druer", w.grapes],
    ["Pris", w.price ? `${w.price.toLocaleString("da-DK")} kr` : ""],
    ["Placering", w.location],
  ].filter(([, v]) => v);

  openSheet(`
    ${w.imagePath ? `<img class="photo" data-img="${escapeHtml(w.imagePath)}" alt="">` : ""}
    <h2>${escapeHtml(wineTitle(w))}</h2>
    <p class="sub">${escapeHtml(wineMeta(w))}</p>
    ${statusHtml(w, true)}
    <div class="section-label">Drikkevindue</div>
    <div>${windowText(w)}</div>
    ${w.description ? `<div class="section-label">Karakter og smag</div><p class="description">${escapeHtml(w.description)}</p>` : ""}
    ${w.foodPairings?.length ? `<div class="section-label">Passer til</div><div class="chips">${w.foodPairings.map((f) => `<span class="chip">${escapeHtml(f)}</span>`).join("")}</div>` : ""}
    ${facts.length ? `<div class="section-label">Fakta</div><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>` : ""}
    ${w.notes ? `<div class="section-label">Mine noter</div><p class="description">${escapeHtml(w.notes)}</p>` : ""}

    <div class="section-label">På lager</div>
    <div class="stepper">
      <button type="button" data-act="dec" aria-label="Én mindre">−</button>
      <output id="detail-qty">${w.quantity}</output>
      <button type="button" data-act="inc" aria-label="Én mere">+</button>
    </div>

    <div class="actions" style="margin-top:12px">
      <button type="button" class="primary" data-act="drink" ${w.quantity ? "" : "disabled"}>🍷 Drik en flaske</button>
    </div>

    ${wineTastings.length ? `
      <div class="section-label">Drukket</div>
      <ul class="history-list">${wineTastings.map((t) => `
        <li><strong>${formatDate(t.drunkAt)}</strong> ${starsHtml(t.rating)}
        ${t.notes ? `<div class="notes">${escapeHtml(t.notes)}</div>` : ""}</li>`).join("")}
      </ul>` : ""}

    <div class="actions" style="margin-top:20px">
      <button type="button" data-act="edit">Redigér</button>
      <button type="button" class="danger" data-act="delete">Slet</button>
    </div>`);

  const body = $("#sheet-body");
  body.onclick = (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "inc" || act === "dec") {
      if (act === "dec" && w.quantity === 0) return;
      w.quantity += act === "inc" ? 1 : -1;
      $("#detail-qty").textContent = w.quantity;
      $('[data-act="drink"]', body).disabled = !w.quantity;
      markChanged(w.id);
      save();
    } else if (act === "drink") {
      openRate(w);
    } else if (act === "edit") {
      openEdit(w);
    } else if (act === "delete") {
      if (!confirm(`Slet "${wineTitle(w)}" helt – også historik? Brug hellere "Drik", hvis du har drukket den.`)) return;
      wines = wines.filter((x) => x.id !== w.id);
      tastings = tastings.filter((t) => t.wineId !== w.id);
      markDeleted(w.id);
      if (w.imagePath) db.storage.from("labels").remove([w.imagePath]).catch(() => {});
      closeSheet();
      save();
      toast("Vinen er slettet");
    }
  };
}

// ============================================================
// Ny vin med foto
// ============================================================

$("#btn-add").addEventListener("click", startAdd);

async function startAdd() {
  const file = await takePhoto();
  if (!file) return;
  let token = openSheet(loadingHtml("Forbereder billedet…"));
  let image;
  try {
    image = await prepareImage(file);
  } catch (err) {
    openSheet(errorHtml("Billedet kunne ikke bruges", err.message, "Tag nyt billede"));
    $('[data-act="retry"]').onclick = startAdd;
    return;
  }

  const run = async () => {
    token = openSheet(`<img class="photo small" src="${image.dataUrl}" alt="">` +
      loadingHtml("Genkender vinen…", "AI'en læser etiketten og finder smag, drikkevindue og madparring. Det tager typisk 20–60 sekunder."));
    try {
      const result = await ai("identify", { image: image.dataUrl });
      if (token !== sheetToken) return;
      openReview({ ...result.wine, quantity: 1 }, { image, result });
    } catch (err) {
      if (token !== sheetToken) return;
      openSheet(`<img class="photo small" src="${image.dataUrl}" alt="">` + errorHtml("Vinen kunne ikke genkendes", err.message) +
        `<p style="text-align:center"><button type="button" class="link" data-act="manual">Udfyld selv i stedet</button></p>`);
      $('[data-act="retry"]').onclick = run;
      $('[data-act="manual"]').onclick = () => openReview({ type: "Rød", quantity: 1 }, { image });
    }
  };
  run();
}

function findDuplicate(w) {
  const key = (x) => [x.producer, x.name, x.vintage ?? ""].map((v) => String(v ?? "").trim().toLowerCase()).join("|");
  const k = key(w);
  return wines.find((x) => x.id !== w.id && key(x) === k);
}

// Gennemse og ret oplysninger før de gemmes (bruges til ny vin og redigering).
function openReview(draft, { image = null, result = null, editing = false } = {}) {
  const typeOptions = WINE_TYPES.map((t) => `<option ${t === draft.type ? "selected" : ""}>${t}</option>`).join("");
  const conf = result?.confidence;
  const notices = [];
  if (result && conf && conf !== "høj") notices.push(`AI'en er <strong>${escapeHtml(conf)}</strong> sikker på genkendelsen – tjek oplysningerne.`);
  if (result?.uncertain) notices.push(escapeHtml(result.uncertain));
  if (result && result.searched === false) notices.push("Oplysningerne bygger på AI'ens egen viden (uden søgning på nettet).");

  const photoSrc = image?.dataUrl;
  openSheet(`
    ${photoSrc ? `<img class="photo small" src="${photoSrc}" alt="">` : draft.imagePath ? `<img class="photo small" data-img="${escapeHtml(draft.imagePath)}" alt="">` : ""}
    <h2>${editing ? "Redigér vin" : result ? "Er det den rigtige vin?" : "Ny vin"}</h2>
    ${notices.length ? `<div class="notice">${notices.join("<br>")}</div>` : ""}
    <div id="dup-notice"></div>
    <form id="review-form" class="stack" autocomplete="off">
      ${editing ? "" : `
        <div>
          <div class="section-label" style="margin-top:0;text-align:center">Antal flasker</div>
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="Én mindre">−</button>
            <output name="qtyOut">${draft.quantity ?? 1}</output>
            <button type="button" data-step="1" aria-label="Én mere">+</button>
          </div>
        </div>`}
      <label>Producent<input name="producer" value="${escapeHtml(draft.producer)}"></label>
      <label>Navn<input name="name" required value="${escapeHtml(draft.name)}"></label>
      <div class="row">
        <label>Årgang<input name="vintage" type="number" inputmode="numeric" min="1800" max="2100" value="${draft.vintage ?? ""}"></label>
        <label>Type<select name="type">${typeOptions}</select></label>
      </div>
      <div class="row">
        <label>Land<input name="country" value="${escapeHtml(draft.country)}"></label>
        <label>Region<input name="region" value="${escapeHtml(draft.region)}"></label>
      </div>
      <label>Druer<input name="grapes" value="${escapeHtml(draft.grapes)}"></label>
      <div class="row">
        <label>Drik fra (år)<input name="drinkFrom" type="number" inputmode="numeric" min="1800" max="2100" value="${draft.drinkFrom ?? ""}"></label>
        <label>Drik til (år)<input name="drinkTo" type="number" inputmode="numeric" min="1800" max="2100" value="${draft.drinkTo ?? ""}"></label>
      </div>
      <label>Karakter og smag<textarea name="description" rows="3">${escapeHtml(draft.description)}</textarea></label>
      <label>Passer til (adskil med komma)<input name="foodPairings" value="${escapeHtml((draft.foodPairings ?? []).join(", "))}"></label>
      <div class="row">
        <label>Pris pr. flaske (kr)<input name="price" type="number" inputmode="decimal" min="0" step="0.01" value="${draft.price ?? ""}"></label>
        <label>Placering<input name="location" value="${escapeHtml(draft.location)}" placeholder="fx Reol A"></label>
      </div>
      <label>Mine noter<textarea name="notes" rows="2">${escapeHtml(draft.notes)}</textarea></label>
      <p id="review-error" class="notice error" hidden></p>
      <div class="actions">
        <button type="submit" class="primary" id="review-save">${editing ? "Gem ændringer" : "Gem i kælderen"}</button>
        <button type="button" data-close>Annullér</button>
      </div>
    </form>`);

  const form = $("#review-form");
  let qty = draft.quantity ?? 1;

  const checkDup = () => {
    if (editing) return;
    const dup = findDuplicate({ producer: form.elements.producer.value, name: form.elements.name.value, vintage: num(form.elements.vintage.value) });
    $("#dup-notice").innerHTML = dup
      ? `<div class="notice">Du har allerede denne vin (${dup.quantity} fl.). Flaskerne lægges til den eksisterende.</div>`
      : "";
    return dup;
  };
  checkDup();
  form.addEventListener("input", checkDup);

  $$("[data-step]", form).forEach((b) => b.addEventListener("click", () => {
    qty = Math.max(1, qty + Number(b.dataset.step));
    form.elements.qtyOut.value = qty;
  }));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#review-save");
    btn.disabled = true;
    btn.textContent = "Gemmer…";
    try {
      const d = Object.fromEntries(new FormData(form));
      const fields = {
        producer: d.producer.trim(),
        name: d.name.trim(),
        vintage: num(d.vintage),
        type: d.type,
        country: d.country.trim(),
        region: d.region.trim(),
        grapes: d.grapes.trim(),
        drinkFrom: num(d.drinkFrom),
        drinkTo: num(d.drinkTo),
        description: d.description.trim(),
        foodPairings: d.foodPairings.split(",").map((s) => s.trim()).filter(Boolean),
        price: num(d.price),
        location: d.location.trim(),
        notes: d.notes.trim(),
      };

      let wine;
      if (editing) {
        wine = wines.find((x) => x.id === draft.id);
        Object.assign(wine, fields);
      } else {
        const dup = checkDup();
        if (dup) {
          wine = dup;
          // Behold eksisterende oplysninger, men udfyld tomme felter.
          for (const [k, v] of Object.entries(fields)) {
            const empty = wine[k] == null || wine[k] === "" || (Array.isArray(wine[k]) && !wine[k].length);
            if (empty) wine[k] = v;
          }
          wine.quantity += qty;
        } else {
          wine = { id: crypto.randomUUID(), ...fields, quantity: qty, imagePath: "", added: new Date().toISOString() };
          if (result?.sources?.length) wine.aiSources = result.sources;
          wines.push(wine);
        }
      }

      if (image && (!wine.imagePath || !editing)) {
        try {
          wine.imagePath = await uploadLabel(wine.id, image.blob);
        } catch (err) {
          console.warn("Billedet kunne ikke gemmes", err);
        }
      }

      markChanged(wine.id);
      save();
      closeSheet();
      toast(editing ? "Ændringerne er gemt" : `${qty} fl. ${wineTitle(wine)} er lagt i kælderen`);
    } catch (err) {
      $("#review-error").hidden = false;
      $("#review-error").textContent = "Kunne ikke gemme: " + err.message;
      btn.disabled = false;
      btn.textContent = editing ? "Gem ændringer" : "Gem i kælderen";
    }
  });
}

function openEdit(w) {
  openReview({ ...w }, { editing: true });
}

$("#btn-manual").addEventListener("click", () => openReview({ type: "Rød", quantity: 1 }));

// ============================================================
// Drik en vin
// ============================================================

$("#btn-drink").addEventListener("click", startDrink);

async function startDrink() {
  if (!inStock().length) return toast("Du har ingen vine på lager endnu.");
  const file = await takePhoto();
  if (!file) return;
  let token = openSheet(loadingHtml("Forbereder billedet…"));
  let image;
  try {
    image = await prepareImage(file, 1024, 0.8);
  } catch (err) {
    openSheet(errorHtml("Billedet kunne ikke bruges", err.message, "Tag nyt billede"));
    $('[data-act="retry"]').onclick = startDrink;
    return;
  }

  const run = async () => {
    token = openSheet(`<img class="photo small" src="${image.dataUrl}" alt="">` + loadingHtml("Finder vinen i din kælder…"));
    try {
      const list = inStock().map((w) => ({ id: w.id, name: w.name, producer: w.producer, vintage: w.vintage, region: w.region }));
      const r = await ai("match", { image: image.dataUrl, wines: list });
      if (token !== sheetToken) return;
      const w = wines.find((x) => x.id === r.id);
      if (!w) return openPick(image, r.alternatives, r.label ? `AI'en læste: "${r.label}", men fandt den ikke i din kælder.` : "");
      openSheet(`
        <img class="photo small" src="${image.dataUrl}" alt="">
        <h2>Er det denne vin?</h2>
        <ul class="wine-list">${wineItemHtml(w)}</ul>
        ${r.confidence !== "høj" ? `<p class="muted small-text" style="margin-top:8px">AI'en er ${escapeHtml(r.confidence)} sikker.</p>` : ""}
        <div class="actions" style="margin-top:14px">
          <button type="button" class="primary" data-act="yes">Ja, det er den</button>
          <button type="button" data-act="other">Vælg en anden</button>
        </div>`);
      $('[data-act="yes"]').onclick = () => openRate(w);
      $('[data-act="other"]').onclick = () => openPick(image, r.alternatives);
    } catch (err) {
      if (token !== sheetToken) return;
      openSheet(errorHtml("Vinen kunne ikke findes", err.message) +
        `<p style="text-align:center"><button type="button" class="link" data-act="pick">Vælg vinen fra listen</button></p>`);
      $('[data-act="retry"]').onclick = run;
      $('[data-act="pick"]').onclick = () => openPick(image);
    }
  };
  run();
}

function openPick(image, preferred = [], message = "") {
  const pref = new Set(preferred);
  const list = inStock().sort((a, b) => (pref.has(b.id) - pref.has(a.id)) || wineTitle(a).localeCompare(wineTitle(b), "da"));
  openSheet(`
    ${image ? `<img class="photo small" src="${image.dataUrl}" alt="">` : ""}
    <h2>Hvilken vin drikker du?</h2>
    ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}
    <input type="search" id="pick-search" placeholder="Søg…" style="margin-bottom:10px">
    <ul class="wine-list pick-list" id="pick-list">${list.map(wineItemHtml).join("")}</ul>`);
  $("#pick-list").onclick = (e) => {
    const item = e.target.closest("[data-id]");
    if (item) openRate(wines.find((w) => w.id === item.dataset.id));
  };
  $("#pick-search").oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$("#pick-list [data-id]").forEach((li) => (li.hidden = !li.textContent.toLowerCase().includes(q)));
  };
}

// Stjerner og noter, derefter trækkes én flaske fra.
function openRate(w) {
  let rating = 0;
  openSheet(`
    <h2>Skål! 🍷</h2>
    <p class="sub">${escapeHtml(wineTitle(w))} ${w.vintage ?? ""}</p>
    <div class="section-label" style="text-align:center">Hvor god var den? (valgfrit)</div>
    <div class="stars" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} stjerner">★</button>`).join("")}</div>
    <label style="margin-top:16px">Mine noter (valgfrit)<textarea id="rate-notes" rows="3" placeholder="Hvordan smagte den? Hvad fik I til?"></textarea></label>
    <p id="rate-error" class="notice error" hidden></p>
    <div class="actions" style="margin-top:16px">
      <button type="button" class="primary" id="rate-save">Træk én flaske fra</button>
      <button type="button" data-close>Annullér</button>
    </div>`);

  $("#stars").onclick = (e) => {
    const b = e.target.closest("[data-n]");
    if (!b) return;
    const n = Number(b.dataset.n);
    rating = rating === n ? 0 : n;
    $$("#stars button").forEach((s) => s.classList.toggle("on", Number(s.dataset.n) <= rating));
  };

  $("#rate-save").onclick = async () => {
    const btn = $("#rate-save");
    btn.disabled = true;
    btn.textContent = "Gemmer…";
    const notes = $("#rate-notes").value.trim();
    try {
      // Vinen skal findes online, før smagningen kan gemmes.
      await flushWine(w.id);
      const { data, error } = await db.from("tastings")
        .insert({ wine_id: w.id, rating: rating || null, notes: notes || null })
        .select().single();
      if (error) throw error;
      tastings.unshift(tastingFromRow(data));
      w.quantity = Math.max(0, w.quantity - 1);
      markChanged(w.id);
      save();
      closeSheet();
      toast(w.quantity ? `Skål! ${w.quantity} fl. tilbage` : "Skål! Det var den sidste – den ligger nu under Drukket");
    } catch (err) {
      $("#rate-error").hidden = false;
      $("#rate-error").textContent = navigator.onLine ? "Kunne ikke gemme: " + err.message : "Du er offline. Prøv igen, når du har net.";
      btn.disabled = false;
      btn.textContent = "Træk én flaske fra";
    }
  };
}

// ============================================================
// Hvad skal jeg drikke til maden?
// ============================================================

$("#btn-pair").addEventListener("click", () => openPair());

function openPair(dish = "") {
  if (!inStock().length) return toast("Du har ingen vine på lager endnu.");
  openSheet(`
    <h2>Hvad skal I spise? 🍽️</h2>
    <p class="sub">Du får de 5 bedste vine fra din kælder – vægtet efter hvor godt de passer, og hvor meget de haster.</p>
    <form id="pair-form" class="stack">
      <input name="dish" required placeholder="fx lammekølle med rosmarin" value="${escapeHtml(dish)}" enterkeyhint="search">
      <button type="submit" class="primary">Find vine</button>
    </form>
    <div id="pair-result"></div>`);
  const form = $("#pair-form");
  if (!dish) setTimeout(() => form.dish.focus(), 250);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const token = sheetToken;
    const q = form.dish.value.trim();
    form.dish.blur();
    $("#pair-result").innerHTML = loadingHtml("Finder de bedste vine…");
    try {
      const list = inStock().map((w) => ({
        id: w.id, name: w.name, producer: w.producer, vintage: w.vintage, type: w.type, region: w.region,
        grapes: w.grapes, description: w.description, foodPairings: w.foodPairings,
        drinkFrom: w.drinkFrom, drinkTo: w.drinkTo, quantity: w.quantity,
      }));
      const r = await ai("pair", { dish: q, wines: list, year: thisYear() });
      if (token !== sheetToken) return;
      renderPairResult(r);
    } catch (err) {
      if (token !== sheetToken) return;
      $("#pair-result").innerHTML = `<div class="notice error" style="margin-top:14px">${escapeHtml(err.message)}</div>`;
    }
  };
}

function recHtml(rec, rank, extraClass = "") {
  const w = wines.find((x) => x.id === rec.id);
  if (!w) return "";
  return `
    <li class="rec ${extraClass}" data-id="${w.id}">
      <div class="rank">${rank}</div>
      ${thumbHtml(w)}
      <div>
        <div class="title"><strong>${escapeHtml(wineTitle(w))}</strong> ${w.vintage ?? ""}</div>
        ${statusHtml(w)}
        ${rec.reason ? `<div class="reason">${escapeHtml(rec.reason)}</div>` : ""}
        <div class="meta muted small-text" style="margin:4px 0 0">${escapeHtml(rec.urgencyText)} · ${w.quantity} fl.</div>
      </div>
    </li>`;
}

function renderPairResult(r) {
  const el = $("#pair-result");
  if (!r.top.length && !r.white) {
    el.innerHTML = `<p class="empty">Ingen af dine vine passer rigtig godt til "${escapeHtml(r.dish)}".</p>`;
    return;
  }
  el.innerHTML = `
    <div class="section-label">Top ${r.top.length} til "${escapeHtml(r.dish)}"</div>
    <ul class="rec-list">${r.top.map((x, i) => recHtml(x, i + 1)).join("")}</ul>
    ${r.white ? `
      <div class="rec-white-label">🥂 Ingen hvidvin i top ${r.top.length} – her er den bedste hvidvin:</div>
      <ul class="rec-list">${recHtml(r.white, r.top.length + 1, "white")}</ul>` : ""}`;
  el.onclick = (e) => {
    const item = e.target.closest(".rec[data-id]");
    if (item) openDetail(item.dataset.id);
  };
  refreshThumbs(el);
}

// ============================================================
// Backup
// ============================================================

$("#export-btn").addEventListener("click", () => {
  const data = { wines, tastings };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wine-cellar-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const data = Array.isArray(parsed) ? parsed : parsed.wines;
    if (!Array.isArray(data)) throw new Error("Filen indeholder ikke en liste af vine.");
    if (data.some((w) => !w || typeof w.name !== "string" || !w.name.trim())) {
      throw new Error("Alle vine skal have et navn.");
    }
    if (!confirm(`Importér ${data.length} vine? Det erstatter din nuværende kælder. (Drukket-historik importeres ikke.)`)) return;
    const imported = data.map((w) => ({
      ...w,
      id: UUID_RE.test(w.id) ? w.id : crypto.randomUUID(),
      quantity: Number(w.quantity) || 0,
      foodPairings: Array.isArray(w.foodPairings) ? w.foodPairings : [],
    }));
    const keep = new Set(imported.map((w) => w.id));
    wines.filter((w) => !keep.has(w.id)).forEach((w) => markDeleted(w.id));
    imported.forEach((w) => markChanged(w.id));
    wines = imported;
    save();
  } catch (err) {
    alert("Import fejlede: " + err.message);
  } finally {
    e.target.value = "";
  }
});

// ============================================================
// Start
// ============================================================

(async () => {
  const { data } = await db.auth.getSession();
  if (data.session?.user) onSignedIn(data.session.user);
  else showView(false);
})();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  // Når en ny version af appen er hentet, genindlæses siden automatisk –
  // men aldrig midt i en indtastning (så ventes til appen åbnes igen).
  const hadController = !!navigator.serviceWorker.controller;
  let reloadPending = false;
  const reloadIfIdle = () => {
    if (reloadPending && $("#sheet").hidden) location.reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return; // første installation
    reloadPending = true;
    reloadIfIdle();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reloadIfIdle();
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
}
