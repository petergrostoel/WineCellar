// Wine Cellar – simpel vinkælder-app. Data gemmes i browserens localStorage.

const STORAGE_KEY = "wine-cellar.v1";
const TYPE_COLORS = {
  "Rød": "#7b1e3a",
  "Hvid": "#d8c36a",
  "Rosé": "#e58fa6",
  "Mousserende": "#a7c4d9",
  "Dessert": "#c98a2b",
  "Hedvin": "#5a2a1a",
};

const $ = (sel) => document.querySelector(sel);
const form = $("#wine-form");
const list = $("#wine-list");

let wines = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(wines));
  } catch (err) {
    alert("Kunne ikke gemme data: " + err.message);
  }
}

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
    : "Ingen vine endnu – tilføj den første til venstre.";

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
      break;
    case "dec":
      if (wine.quantity > 0) wine.quantity--;
      break;
    case "delete":
      if (!confirm(`Slet "${wine.name}"?`)) return;
      wines = wines.filter((w) => w.id !== id);
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
    if (!confirm(`Importér ${data.length} vine? Det erstatter din nuværende kælder.`)) return;
    wines = data;
    save();
    render();
  } catch (err) {
    alert("Import fejlede: " + err.message);
  } finally {
    e.target.value = "";
  }
});

render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js");
}
