/* app.js — entry point. Wires the UI, owns render(). Layers: core/ = pure logic +
   network, this file = DOM. */
import { parseAppId, parseCountry, fetchReviews, lookupApp, STOREFRONTS } from "./core/apple.js?v=3";
import { triage, latestVer, cluster, stats, CATEGORIES } from "./core/triage.js?v=2";
import { apiFetch, hasApi, parsePlayId } from "./core/api.js?v=4";

const $ = (s, r = document) => r.querySelector(s);
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
CAT_LABEL.other = "Other";
const STATUS_LABEL = { new: "New", triaged: "Triaged", progress: "In progress", wontfix: "Won't fix", resolved: "Resolved" };

const els = {
  intro: $("#intro"), loading: $("#loading"), loadingText: $("#loading-text"),
  wb: $("#workbench"), form: $("#fetch-form"), appInput: $("#app-input"), country: $("#country"),
  fetchBtn: $("#fetch-btn"), samples: $(".samples"), appIcon: $("#app-icon"), appName: $("#app-name"),
  appMeta: $("#app-meta"), analytics: $("#analytics"), list: $("#list"), listEmpty: $("#list-empty"),
  count: $("#result-count"), search: $("#search"), fSort: $("#f-sort"), fRating: $("#f-rating"),
  fSent: $("#f-sent"), fCat: $("#f-cat"), fVer: $("#f-ver"), fStatus: $("#f-status"),
};

const state = { app: null, appId: null, country: "us", store: "appstore", reviews: [], meta: {}, page: 1 };
const PAGE_SIZE = 25;

const SAMPLES = {
  appstore: [["686449807", "Telegram"], ["618783545", "Slack"], ["310633997", "WhatsApp"]],
  play: [["com.whatsapp", "WhatsApp"], ["com.spotify.music", "Spotify"], ["org.telegram.messenger", "Telegram"]],
};
const PLACEHOLDER = {
  appstore: "https://apps.apple.com/us/app/…/id123456789   or   123456789",
  play: "https://play.google.com/store/apps/details?id=com.example   or   com.example.app",
};
const HINT = {
  appstore: "Tip: open your app on the App Store, copy the page URL, and paste it here.",
  play: hasApi() ? "Tip: open your app on Google Play, copy the URL, and paste it here."
                 : "Play Store needs the backend API (see /api). App Store works right now.",
};

function setStore(store) {
  state.store = store;
  document.querySelectorAll("#storetoggle .st").forEach((b) => {
    const on = b.dataset.store === store; b.classList.toggle("is-on", on); b.setAttribute("aria-selected", String(on));
  });
  $("#store-word").innerHTML = store === "play" ? "Play&nbsp;Store" : "App&nbsp;Store";
  els.appInput.placeholder = PLACEHOLDER[store];
  $("#fetch-hint").textContent = HINT[store];
  $("#samples").innerHTML = `<span>Try:</span>` + SAMPLES[store].map(([id, n]) => `<button class="chipbtn" data-id="${id}">${n}</button>`).join("");
}

function syncCountryLabel() {
  const el = $("#adv-cty");
  if (el) el.textContent = (els.country.value || "us").toUpperCase();
}

/* ── boot ─────────────────────────────────────────── */
els.country.innerHTML = STOREFRONTS.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
els.country.value = "us";
syncCountryLabel();
$("#year").textContent = new Date().getFullYear();
setStore("appstore");
splash();

/* ── fetch flow ───────────────────────────────────── */
$("#storetoggle").addEventListener("click", (e) => { const b = e.target.closest(".st"); if (b) setStore(b.dataset.store); });
els.country.addEventListener("change", syncCountryLabel);
els.appInput.addEventListener("input", () => {
  if (state.store !== "appstore") return;            // Play country comes from the dropdown only
  const c = parseCountry(els.appInput.value);         // e.g. apps.apple.com/de/app/… → "de"
  if (c && c !== els.country.value) { els.country.value = c; syncCountryLabel(); }
});
els.form.addEventListener("submit", (e) => { e.preventDefault(); run(els.appInput.value, els.country.value); });
$("#samples").addEventListener("click", (e) => {
  const b = e.target.closest(".chipbtn"); if (!b) return;
  els.appInput.value = b.dataset.id; run(b.dataset.id, els.country.value);
});
$("#change-btn").addEventListener("click", () => { els.wb.hidden = true; els.intro.hidden = false; els.appInput.focus(); });

async function run(input, country) {
  const store = state.store;
  let id, ctry = country || "us";
  if (store === "play") {
    id = parsePlayId(input);
    if (!id) { toast("Paste a Play Store link or package name (e.g. com.whatsapp)."); return; }
    if (!hasApi()) { toast("Play Store needs the backend API. Deploy /api and set API_BASE in js/core/api.js."); return; }
  } else {
    id = parseAppId(input);
    if (!id) { toast("Paste a valid App Store link or numeric app ID."); return; }
    // Dropdown selection wins. A pasted URL's country is applied to the dropdown
    // on input (see appInput listener), not re-parsed here — so switching country
    // after pasting a URL is respected instead of being overridden.
    ctry = country || "us";
  }
  els.intro.hidden = true; els.wb.hidden = true; els.loading.hidden = false;
  els.loadingText.textContent = "Fetching reviews…";
  try {
    let app, reviews, throttled;
    if (hasApi()) {
      // server-side fetch (both stores) — normalized + cached by the Lambda
      const d = await apiFetch(store, id, ctry, "en");
      app = d.app || {}; reviews = d.reviews || []; throttled = d.throttled;
    } else {
      // no backend configured → client-side Apple RSS fallback (App Store only)
      const [meta, res] = await Promise.all([
        lookupApp(id, ctry).catch(() => null),
        fetchReviews(id, ctry, 10, (page, n) => {
          els.loadingText.textContent = `Fetching reviews… ${n} so far (page ${page})`;
        }),
      ]);
      reviews = res.reviews; throttled = res.throttled;
      app = meta && meta.name ? { name: meta.name, icon: meta.icon, version: meta.version, ratingCount: meta.ratingCount } : res.app;
    }
    if (!reviews.length) {
      els.loading.hidden = true; els.intro.hidden = false;
      toast(throttled
        ? "The store's review feed is rate-limiting right now (it returns empty when queried too often). Give it a minute and try again."
        : "No public reviews found for that app / storefront.");
      return;
    }
    state.app = app || {}; state.appId = id; state.country = ctry; state.store = store;
    state.reviews = triage(reviews, { latestVersion: (app && app.version) || latestVer(reviews) });
    state.meta = {};
    enterWorkbench();
  } catch (err) {
    els.loading.hidden = true; els.intro.hidden = false;
    toast("Couldn't fetch reviews. " + (err && err.message ? err.message : "The app may have no public reviews."));
    console.warn(err);
  }
}

function enterWorkbench() {
  els.loading.hidden = true; els.intro.hidden = true; els.wb.hidden = false;
  els.appIcon.src = state.app.icon || "assets/logo-icon.webp";
  els.appIcon.onerror = () => { els.appIcon.onerror = null; els.appIcon.src = "assets/logo-icon.webp"; };
  els.appName.textContent = state.app.name || "App";
  const ver = state.app.version || latestVer(state.reviews) || "—";
  const rc = state.app.ratingCount ? ` · ${Number(state.app.ratingCount).toLocaleString()} total ratings` : "";
  const storeLabel = state.store === "play" ? "Play Store" : "App Store";
  els.appMeta.textContent = `${state.reviews.length} reviews analyzed${rc} · ${state.country.toUpperCase()} ${storeLabel} · latest v${ver}`;
  // populate category + version filters from data
  const cats = new Set(); const vers = new Set();
  state.reviews.forEach((r) => { (r.categories || []).forEach((c) => cats.add(c)); if (r.version) vers.add(r.version); });
  els.fCat.innerHTML = `<option value="">All categories</option>` + [...cats].map((c) => `<option value="${c}">${CAT_LABEL[c] || c}</option>`).join("");
  els.fVer.innerHTML = `<option value="">All versions</option>` + [...vers].sort().reverse().map((v) => `<option value="${v}">v${v}</option>`).join("");
  state.page = 1;
  render();
}

/* ── filtering + render ───────────────────────────── */
[els.search, els.fSort, els.fRating, els.fSent, els.fCat, els.fVer, els.fStatus].forEach((el) =>
  el.addEventListener("input", () => { state.page = 1; render(); }));

$("#pager").addEventListener("click", (e) => {
  const b = e.target.closest(".pager__btn"); if (!b || b.disabled) return;
  const n = Number(b.dataset.page);
  if (!n || n === state.page) return;
  state.page = n;
  render();
  els.list.scrollIntoView({ behavior: "smooth", block: "start" });
});

function filtered() {
  const q = els.search.value.trim().toLowerCase();
  const rating = els.fRating.value, sent = els.fSent.value, cat = els.fCat.value, ver = els.fVer.value, st = els.fStatus.value;
  let list = state.reviews.filter((r) => {
    if (rating && String(r.rating) !== rating) return false;
    if (sent && r.sentiment !== sent) return false;
    if (cat && !(r.categories || []).includes(cat)) return false;
    if (ver && r.version !== ver) return false;
    if (st && (meta(r.id).status || "new") !== st) return false;
    if (q && !(`${r.title} ${r.text} ${r.author}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const s = els.fSort.value;
  list.sort((a, b) =>
    s === "date" ? (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
    : s === "rating-asc" ? a.rating - b.rating || b.priority - a.priority
    : s === "rating-desc" ? b.rating - a.rating || b.priority - a.priority
    : b.priority - a.priority || (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return list;
}

function render() {
  renderAnalytics();
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page), pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageItems = list.slice(start, start + PAGE_SIZE);
  els.count.textContent = list.length
    ? `${start + 1}–${start + pageItems.length} of ${list.length}`
    : `0 of ${state.reviews.length}`;
  els.listEmpty.hidden = list.length > 0;
  els.list.innerHTML = pageItems.map(revHtml).join("");
  renderPager(pages);
}

function pageWindow(p, pages) {
  const set = new Set([1, pages, p, p - 1, p + 1]);
  if (p <= 3) [2, 3, 4].forEach((n) => set.add(n));
  if (p >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((n) => set.add(n));
  return [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
}

function renderPager(pages) {
  const pager = $("#pager"); if (!pager) return;
  if (pages <= 1) { pager.innerHTML = ""; pager.hidden = true; return; }
  pager.hidden = false;
  const p = state.page;
  const btn = (label, target, o = {}) =>
    `<button class="pager__btn${o.active ? " is-active" : ""}"${o.disabled ? " disabled" : ""}${o.active ? ' aria-current="page"' : ""} data-page="${target}">${label}</button>`;
  let html = btn("‹ Prev", p - 1, { disabled: p <= 1 });
  let prev = 0;
  for (const n of pageWindow(p, pages)) {
    if (n - prev > 1) html += `<span class="pager__gap">…</span>`;
    html += btn(String(n), n, { active: n === p });
    prev = n;
  }
  html += btn("Next ›", p + 1, { disabled: p >= pages });
  pager.innerHTML = html;
}

function renderAnalytics() {
  const s = stats(state.reviews);
  const app = state.app || {};
  const hist = (Array.isArray(app.histogram) && app.histogram.length === 5)
    ? app.histogram.map((n) => Number(n) || 0) : null;
  let avg, count, dist, distNote;
  if (hist) {
    // Play: derive avg + total from the histogram so the number always matches the bars.
    const total = hist.reduce((a, b) => a + b, 0);
    const weighted = hist.reduce((a, c, i) => a + (i + 1) * c, 0);
    avg = total ? (weighted / total).toFixed(2) : "—";
    count = total;
    dist = { 1: hist[0], 2: hist[1], 3: hist[2], 4: hist[3], 5: hist[4] };
    distNote = `Full ${(state.country || "us").toUpperCase()} breakdown of all ${fmtNum(total)} ratings — Play ratings vary by country.`;
  } else {
    // App Store (no histogram): true store avg + total from Lookup; bars from the sample.
    avg = app.avgRating ? Number(app.avgRating).toFixed(2) : s.avg;
    count = app.ratingCount ? Number(app.ratingCount) : s.total;
    dist = s.dist;
    distNote = `Bars from the ${s.total} reviews fetched${state.store === "appstore" ? " — Apple publishes no full star breakdown" : ""}. Avg &amp; total are store-wide.`;
  }
  const max = Math.max(1, ...Object.values(dist));
  const distRows = [5, 4, 3, 2, 1].map((n) =>
    `<div class="dist__row"><i>${n}★</i><span class="dist__bar"><span style="width:${(dist[n] / max) * 100}%"></span></span>${fmtNum(dist[n])}</div>`).join("");
  const themes = cluster(state.reviews, 2).slice(0, 8)
    .map((c) => `<span class="theme">${esc(c.label)}<b>${c.count}</b></span>`).join("") || `<span class="theme">—</span>`;
  els.analytics.innerHTML = `
    <div class="card"><h3>Rating</h3><div class="avg"><b>${avg}</b><span>avg · ${fmtNum(count)} ratings · ${esc((state.country || "us").toUpperCase())}</span></div><div class="dist">${distRows}</div><div class="dist__note">${distNote}</div></div>
    <div class="card"><h3>Sentiment</h3><div class="sent">
      <div class="sent__pill neg"><b>${s.neg}</b><span>Negative</span></div>
      <div class="sent__pill neu"><b>${s.neu}</b><span>Neutral</span></div>
      <div class="sent__pill pos"><b>${s.pos}</b><span>Positive</span></div></div>
      <div class="dist__note">From the ${s.total} reviews fetched.</div></div>
    <div class="card"><h3>Top themes</h3><div class="themes">${themes}</div></div>`;
}

function revHtml(r) {
  const m = meta(r.id);
  const status = m.status || "new";
  const done = status === "resolved" || status === "wontfix";
  const stars = "★".repeat(r.rating) + `<i>${"★".repeat(5 - r.rating)}</i>`;
  const cats = (r.categories || []).map((c) => `<span class="cat">${CAT_LABEL[c] || c}</span>`).join("");
  const opts = Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}"${v === status ? " selected" : ""}>${l}</option>`).join("");
  return `<article class="rev${done ? " is-done" : ""}" data-id="${esc(r.id)}" data-pl="${r.priorityLabel}">
    <div class="rev__head">
      <span class="stars">${stars}</span>
      <span class="rev__author">${esc(r.author)}</span>
      <span class="rev__dot">·</span><span class="rev__date">${fmtDate(r.date)}</span>
      ${r.version ? `<span class="rev__dot">·</span><span class="rev__ver">v${esc(r.version)}</span>` : ""}
      <span class="sbadge sbadge--${r.sentiment}">${r.sentiment}</span>
      <span class="badge badge--pl badge--${r.priorityLabel}">P${r.priority} · ${r.priorityLabel}</span>
    </div>
    ${r.title ? `<div class="rev__title">${esc(r.title)}</div>` : ""}
    <div class="rev__text">${esc(r.text)}</div>
    <div class="rev__foot">
      ${cats}
      <button class="notebtn${m.note ? " has-note" : ""}" data-act="note">${m.note ? "✎ Note" : "+ Note"}</button>
      <select class="rev__status" data-act="status" aria-label="Status">${opts}</select>
    </div>
    ${m.note ? `<textarea class="rev__note" data-act="noteinput" placeholder="Private note…">${esc(m.note)}</textarea>` : ""}
  </article>`;
}

/* ── per-review interactions (event delegation) ───── */
els.list.addEventListener("change", (e) => {
  const rev = e.target.closest(".rev"); if (!rev) return;
  const id = rev.dataset.id;
  if (e.target.dataset.act === "status") { setMeta(id, { status: e.target.value }); render(); }
});
els.list.addEventListener("click", (e) => {
  const rev = e.target.closest(".rev"); if (!rev) return;
  const id = rev.dataset.id;
  if (e.target.dataset.act === "note") {
    const m = meta(id);
    if (m.note) return; // already showing
    setMeta(id, { note: " " }); render();
    const ta = els.list.querySelector(`.rev[data-id="${cssEsc(id)}"] .rev__note`);
    if (ta) { ta.value = ""; ta.focus(); }
  }
});
els.list.addEventListener("input", (e) => {
  if (e.target.dataset.act !== "noteinput") return;
  const rev = e.target.closest(".rev");
  setMeta(rev.dataset.id, { note: e.target.value });
});

/* ── exports ──────────────────────────────────────── */
$("#exp-csv").addEventListener("click", () => {
  const rows = [["rating", "sentiment", "priority", "priority_label", "categories", "version", "date", "author", "title", "text", "status", "note"]];
  for (const r of state.reviews) {
    const m = meta(r.id);
    rows.push([r.rating, r.sentiment, r.priority, r.priorityLabel, (r.categories || []).join("|"), r.version, r.date,
      r.author, r.title, r.text, m.status || "new", m.note || ""]);
  }
  download(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `store-reviews-${state.appId}.csv`, "text/csv");
  toast("CSV exported 📄");
});
$("#exp-md").addEventListener("click", () => {
  const s = stats(state.reviews);
  const top = [...state.reviews].filter((r) => r.priority >= 40).sort((a, b) => b.priority - a.priority).slice(0, 20);
  const themes = cluster(state.reviews, 2).slice(0, 10);
  let md = `# ${state.app.name} — review triage\n\n`;
  md += `**${s.total}** reviews · avg **${s.avg}★** · ${s.neg} negative / ${s.neu} neutral / ${s.pos} positive · ${state.country.toUpperCase()} store\n\n`;
  md += `## Rating distribution\n` + [5, 4, 3, 2, 1].map((n) => `- ${n}★ — ${s.dist[n]}`).join("\n") + `\n\n`;
  md += `## Top themes\n` + (themes.map((c) => `- **${c.label}** ×${c.count} (avg ${c.avgRating}★)`).join("\n") || "- —") + `\n\n`;
  md += `## Priority queue (P≥40)\n`;
  md += top.map((r) => `- **[P${r.priority} ${r.priorityLabel}]** ${r.rating}★ ${r.version ? "v" + r.version + " " : ""}— ${(r.categories || []).map((c) => CAT_LABEL[c]).join(", ")}\n  > ${(r.title ? r.title + ": " : "") + r.text}`.trim()).join("\n") || "- none";
  download(md, `store-reviews-${state.appId}.md`, "text/markdown");
  toast("Report exported 📝");
});
$("#exp-issues").addEventListener("click", async () => {
  const top = [...state.reviews].filter((r) => r.priority >= 40).sort((a, b) => b.priority - a.priority).slice(0, 15);
  if (!top.length) { toast("No high-priority reviews to turn into issues."); return; }
  const text = top.map((r) => {
    const cat = (r.categories || []).map((c) => CAT_LABEL[c]).join("/") || "General";
    return `### [${cat}] ${r.title || r.text.slice(0, 60)}\n- Priority: P${r.priority} (${r.priorityLabel}) · ${r.rating}★ · ${r.version ? "v" + r.version : ""} · ${fmtDate(r.date)}\n- Reviewer: ${r.author}\n\n> ${r.text}\n`;
  }).join("\n---\n\n");
  const ok = await copyText(text);
  toast(ok ? `Copied ${top.length} issues to clipboard 📋` : "Couldn't copy");
});

/* ── meta (per-review status/note — in memory for this session only) ─ */
function meta(id) { return state.meta[id] || {}; }
function setMeta(id, patch) { state.meta[id] = { ...meta(id), ...patch }; }

/* ── utils ────────────────────────────────────────── */
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }
function csvCell(v) { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function fmtDate(d) { const t = Date.parse(d); return t ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : ""; }
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, "") + "K";
  return n.toLocaleString();
}
function download(data, name, type) {
  const blob = new Blob([data], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function copyText(t) {
  try { if (navigator.clipboard && isSecureContext) { await navigator.clipboard.writeText(t); return true; } } catch (_) {}
  try { const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; } catch (_) { return false; }
}
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; void t.offsetWidth; t.classList.add("is-show"); clearTimeout(toastT); toastT = setTimeout(() => { t.classList.remove("is-show"); setTimeout(() => (t.hidden = true), 250); }, 2400); }
function splash() {
  const el = $("#splash"); if (!el) return;
  if (document.documentElement.classList.contains("no-splash")) { el.remove(); return; }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dismiss = () => { try { sessionStorage.setItem("store-reviews:splashed", "1"); } catch (_) {} el.classList.add("is-hiding"); setTimeout(() => el.remove(), reduced ? 150 : 500); };
  el.addEventListener("click", dismiss);
  setTimeout(dismiss, reduced ? 400 : 1600);
}
