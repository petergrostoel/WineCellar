// Wine Cellar – vinkælder-app.
// Data gemmes online i Supabase (bag login) og holdes også som lokal kopi,
// så appen virker offline. Ændringer lavet offline sendes op, når der er net.

const CACHE_KEY = "wine-cellar.v1";            // lokal kopi af vinene
const PENDING_KEY = "wine-cellar.pending.v1";  // ændringer der mangler at blive sendt op
const OWNER_KEY = "wine-cellar.owner.v1";      // hvilken bruger den lokale kopi tilhører
const TYPE_COLORS = {
  "Rød": "#7b1e3a",
  "Hvid": "#d8c36a",
  "Rosé": "#e58fa6",
  "Mousserende": "#a7c4d9",
  "Dessert": "#c98a2b",
  "Hedvin": "#5a2a1a",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const $ = (sel) => document.querySelector(sel);
const form = $("#wine-form");
const list = $("#wine-list");

const { supabaseUrl, supabaseKey } = window.WINE_CELLAR_CONFIG;
const db = supabase.createClient(supabaseUrl, supabaseKey);

let user = null;
let wines = readJson(CACHE_KEY, []);
// upserts: { id: revision } – revisionen sikrer, at en ændring lavet mens
// vi synkroniserer ikke bliver glemt.
let pending = readJson(PENDING_KEY, null) ?? {
  upserts: Object.fromEntries(wines.map((w) => [w.id, 1])),
  deletes: [],
};
let rev = Date.now();

// ---------- Lokal lagring ----------

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
  sync();
}

// ---------- Synkronisering med Supabase ----------

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
    added: r.created_at,
  };
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
    const { data, error } = await db.from("wines").select("*");
    if (error) throw error;
    if (!hasPending()) {
      wines = data.map(fromRow);
      persist();
      render();
    }
    setSync("ok", "✓ Gemt online");
  } catch (err) {
    console.error("Synkronisering fejlede", err);
    if (navigator.onLine) setSync("error", "⚠ Ikke gemt online endnu");
    else setSync("pending", "Offline – gemmes senere");
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      sync();
    }
  }
}

window.addEventListener("online", sync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sync();
});
setInterval(() => {
  if (hasPending()) sync();
}, 30000);

// ---------- Login ----------

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
  const buttons = e.target.querySelectorAll("button");
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

$("#logout-btn").addEventListener("click", async () => {
  if (hasPending() && !confirm("Nogle ændringer er endnu ikke gemt online og går tabt, hvis du logger ud. Log ud alligevel?")) return;
  await db.auth.signOut();
});

db.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    if (user?.id !== session.user.id) onSignedIn(session.user);
  } else if (event === "SIGNED_OUT") {
    user = null;
    wines = [];
    pending = { upserts: {}, deletes: [] };
    persist();
    try {
      localStorage.removeItem(OWNER_KEY);
    } catch {}
    showView(false);
  }
});

// ---------- Visning ----------

function num(v) {
  return v === "" || v == null ? null : Number(v);
}

function drinkStatus(w) {
  const year = new Date().getFullYear();
  if (!w.drinkFrom && !w.drinkTo) return null;
  if (w.drinkFrom && year < w.drinkFrom) return { cls: "wait", text: `Gem til ${w.drinkFrom}` };
  if (w.drinkTo && year > w.drinkTo) return { cls: "past", text: "Over drikkevinduet" };
  if (w.drinkTo && w.drinkTo - year <= 1) return { cls: "soon", text: `Drik inden ${w.drinkTo + 1}` };
  return { cls: "ready", text: "Klar til at drikke" };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function render() {
  const q = $("#search").value.trim().toLowerCase();
  const type = $("#filter-type").value;
  const sort = $("#sort").value;
  const hideEmpty = $("#hide-empty").checked;

  const visible = wines
    .filter((w) => !type || w.type === type)
    .filter((w) => !hideEmpty || w.quantity > 0)
    .filter((w) => !q || [w.name, w.producer, w.country, w.region, w.grapes, w.location]
      .some((f) => (f || "").toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "da");
      const av = a[sort] ?? Infinity, bv = b[sort] ?? Infinity;
      return sort === "quantity" ? bv - av : av - bv;
    });

  list.innerHTML = visible.map((w) => {
    const status = drinkStatus(w);
    const meta = [w.producer, w.vintage, [w.region, w.country].filter(Boolean).join(", "), w.grapes]
      .filter(Boolean).map(escapeHtml).join(" · ");
    return `
      <li class="wine ${w.quantity > 0 ? "" : "empty-stock"}" style="--type-color:${TYPE_COLORS[w.type] || ""}" data-id="${w.id}">
        <div>
          <h3>${escapeHtml(w.name)}</h3>
          <div class="meta">${escapeHtml(w.type)}${meta ? " · " + meta : ""}</div>
          ${w.location ? `<div class="meta">📍 ${escapeHtml(w.location)}</div>` : ""}
        </div>
        <div class="side">
          <div class="qty">
            <button data-action="dec" title="Drak en flaske">−</button>
            <span>${w.quantity}</span>
            <button data-action="inc" title="Tilføj en flaske">+</button>
          </div>
          ${status ? `<span class="badge ${status.cls}">${status.text}</span>` : ""}
          <div class="links">
            <button data-action="edit">Redigér</button>
            <button data-action="delete">Slet</button>
          </div>
        </div>
        ${w.notes ? `<p class="notes">${escapeHtml(w.notes)}</p>` : ""}
      </li>`;
  }).join("");

  $("#empty").hidden = visible.length > 0;
  $("#empty").textContent = wines.length
    ? "Ingen vine matcher din søgning."
    : "Ingen vine endnu – tilføj den første med formularen.";

  renderStats();
}

function renderStats() {
  const bottles = wines.reduce((s, w) => s + (w.quantity || 0), 0);
  const value = wines.reduce((s, w) => s + (w.quantity || 0) * (w.price || 0), 0);
  const ready = wines.filter((w) => w.quantity > 0 && drinkStatus(w)?.cls === "ready").length;
  $("#stats").innerHTML = `
    <span><strong>${bottles}</strong> flasker</span>
    <span><strong>${wines.filter((w) => w.quantity > 0).length}</strong> vine</span>
    <span><strong>${ready}</strong> klar nu</span>
    <span><strong>${value.toLocaleString("da-DK", { maximumFractionDigits: 0 })}</strong> kr</span>`;
}

// ---------- Redigering ----------

function resetForm() {
  form.reset();
  form.id.value = "";
  $("#form-title").textContent = "Tilføj vin";
  $("#submit-btn").textContent = "Tilføj";
  $("#cancel-btn").hidden = true;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(form));
  const wine = {
    id: d.id || crypto.randomUUID(),
    name: d.name.trim(),
    producer: d.producer.trim(),
    type: d.type,
    vintage: num(d.vintage),
    country: d.country.trim(),
    region: d.region.trim(),
    grapes: d.grapes.trim(),
    quantity: num(d.quantity) ?? 0,
    price: num(d.price),
    drinkFrom: num(d.drinkFrom),
    drinkTo: num(d.drinkTo),
    location: d.location.trim(),
    notes: d.notes.trim(),
  };
  const i = wines.findIndex((w) => w.id === wine.id);
  if (i >= 0) wines[i] = { ...wines[i], ...wine };
  else wines.push({ ...wine, added: new Date().toISOString() });
  markChanged(wine.id);
  save();
  resetForm();
  render();
  list.closest(".card").scrollIntoView({ behavior: "smooth" });
});

$("#cancel-btn").addEventListener("click", resetForm);

$("#fab").addEventListener("click", () => {
  resetForm();
  form.scrollIntoView({ behavior: "smooth" });
  form.name.focus({ preventScroll: true });
});

list.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest(".wine").dataset.id;
  const wine = wines.find((w) => w.id === id);
  switch (btn.dataset.action) {
    case "inc":
      wine.quantity++;
      markChanged(id);
      break;
    case "dec":
      if (wine.quantity === 0) return;
      wine.quantity--;
      markChanged(id);
      break;
    case "delete":
      if (!confirm(`Slet "${wine.name}"?`)) return;
      wines = wines.filter((w) => w.id !== id);
      markDeleted(id);
      break;
    case "edit":
      for (const [k, v] of Object.entries(wine)) {
        if (form.elements[k]) form.elements[k].value = v ?? "";
      }
      $("#form-title").textContent = "Redigér vin";
      $("#submit-btn").textContent = "Gem";
      $("#cancel-btn").hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
      return;
  }
  save();
  render();
});

["#search", "#filter-type", "#sort", "#hide-empty"].forEach((sel) =>
  $(sel).addEventListener("input", render));

// ---------- Backup ----------

$("#export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(wines, null, 2)], { type: "application/json" });
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
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("Filen indeholder ikke en liste af vine.");
    if (data.some((w) => !w || typeof w.name !== "string" || !w.name.trim())) {
      throw new Error("Alle vine skal have et navn.");
    }
    if (!confirm(`Importér ${data.length} vine? Det erstatter din nuværende kælder.`)) return;
    const imported = data.map((w) => ({
      ...w,
      id: UUID_RE.test(w.id) ? w.id : crypto.randomUUID(),
      quantity: Number(w.quantity) || 0,
    }));
    const keep = new Set(imported.map((w) => w.id));
    wines.filter((w) => !keep.has(w.id)).forEach((w) => markDeleted(w.id));
    imported.forEach((w) => markChanged(w.id));
    wines = imported;
    save();
    render();
  } catch (err) {
    alert("Import fejlede: " + err.message);
  } finally {
    e.target.value = "";
  }
});

// ---------- Start ----------

(async () => {
  const { data } = await db.auth.getSession();
  if (data.session?.user) onSignedIn(data.session.user);
  else showView(false);
})();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js");
}
