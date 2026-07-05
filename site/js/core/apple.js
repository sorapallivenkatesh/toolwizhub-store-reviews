/* core/apple.js — fetch & parse App Store reviews from Apple's public RSS JSON.
   CORS-friendly (access-control-allow-origin: *), so it runs entirely client-side.
   parseAppId / parseEntry are pure; fetchReviews does the network I/O. */

/** Extract a numeric App Store id from a URL or a raw id string. */
export function parseAppId(input) {
  const s = String(input || "").trim();
  const m = s.match(/id(\d{5,})/) || s.match(/\/(\d{6,})(?:[/?]|$)/) || s.match(/^(\d{5,})$/);
  return m ? m[1] : null;
}

/** Two-letter storefront from a URL if present (…/us/app/…), else null. */
export function parseCountry(input) {
  const m = String(input || "").match(/apps\.apple\.com\/([a-z]{2})\//i);
  return m ? m[1].toLowerCase() : null;
}

const feedUrl = (appId, country, page) =>
  `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;

/** Map one RSS entry → a review object (returns null for the app-metadata entry). */
export function parseEntry(e) {
  if (!e || !e["im:rating"]) return null; // entry[0] is the app itself — no rating
  const val = (o) => (o && o.label) || "";
  const content = e.content ? val(e.content) : val(e["content"]);
  return {
    id: val(e.id) || (val(e.author && e.author.uri) + val(e.updated)),
    author: val(e.author && e.author.name) || "Anonymous",
    title: val(e.title),
    text: content,
    rating: parseInt(val(e["im:rating"]), 10) || 0,
    version: val(e["im:version"]) || "",
    date: val(e.updated) || "",
  };
}

/** App name/icon from the first (metadata) entry, if present. */
function parseApp(feed) {
  const first = Array.isArray(feed.entry) ? feed.entry[0] : feed.entry;
  if (first && first["im:name"]) {
    const img = Array.isArray(first["im:image"]) ? first["im:image"].slice(-1)[0] : first["im:image"];
    return { name: (first["im:name"].label) || "App", icon: (img && img.label) || "" };
  }
  return { name: "App", icon: "" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch one page → { app, entries[] } (entries = raw feed entries). Throws on network error. */
async function fetchPage(appId, country, page) {
  const res = await fetch(feedUrl(appId, country, page), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const feed = (data && data.feed) || {};
  const entries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
  return { app: entries.length ? parseApp(feed) : { name: "App", icon: "" }, entries };
}

/**
 * Fetch up to `maxPages` (Apple caps ~500 recent), paced to avoid tripping Apple's
 * per-IP rate limit. If page 1 comes back empty (Apple returns an empty feed — HTTP 200,
 * no entries — when throttled), retry a couple of times before giving up.
 * onProgress(pageDone, reviewsSoFar).
 * @returns {Promise<{app:{name,icon}, reviews:Array, throttled:boolean}>}
 */
export async function fetchReviews(appId, country = "us", maxPages = 10, onProgress) {
  const seen = new Set();
  const reviews = [];
  let app = { name: "App", icon: "" };
  let throttled = false;

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(300); // be gentle between pages
    let entries;
    try {
      let r = await fetchPage(appId, country, page);
      // page 1 empty ⇒ almost always throttling (a real app has reviews). Retry with backoff.
      if (page === 1 && r.entries.length === 0) {
        for (let attempt = 1; attempt <= 2 && r.entries.length === 0; attempt++) {
          await sleep(900 * attempt);
          r = await fetchPage(appId, country, page);
        }
      }
      if (page === 1 && r.app.name !== "App") app = r.app;
      entries = r.entries;
    } catch (err) {
      if (page === 1) throw err; // surface a first-page network/CORS failure
      break;
    }
    if (entries.length === 0) { if (page === 1) throttled = true; break; }
    let added = 0;
    for (const e of entries) {
      const rev = parseEntry(e);
      if (rev && !seen.has(rev.id)) { seen.add(rev.id); rev.store = "appstore"; rev.country = country; reviews.push(rev); added++; }
    }
    if (onProgress) onProgress(page, reviews.length);
    if (added === 0) break;
  }
  return { app, reviews, throttled: throttled && reviews.length === 0 };
}

/**
 * Look up an app's real name/icon/version via the iTunes Lookup API.
 * That endpoint isn't CORS-enabled, so we use JSONP (a <script> callback) which
 * bypasses CORS. Resolves to null on failure (caller falls back gracefully).
 * @returns {Promise<{name,icon,version,avgRating,ratingCount,seller}|null>}
 */
export function lookupApp(appId, country = "us") {
  return new Promise((resolve) => {
    const cb = "__srlk_" + Math.random().toString(36).slice(2, 10);
    const script = document.createElement("script");
    const cleanup = () => { try { delete window[cb]; } catch (_) { window[cb] = undefined; } script.remove(); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, 8000);
    window[cb] = (data) => {
      clearTimeout(timer); cleanup();
      const r = data && data.results && data.results[0];
      resolve(r ? {
        name: r.trackName || "App",
        icon: r.artworkUrl512 || r.artworkUrl100 || "",
        version: r.version || "",
        avgRating: r.averageUserRating || 0,
        ratingCount: r.userRatingCount || 0,
        seller: r.sellerName || "",
      } : null);
    };
    script.onerror = () => { clearTimeout(timer); cleanup(); resolve(null); };
    script.src = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}&callback=${cb}`;
    document.head.appendChild(script);
  });
}

/** Storefronts offered in the UI (kept short; Apple supports ~155). */
export const STOREFRONTS = [
  ["us", "United States"], ["gb", "United Kingdom"], ["in", "India"], ["ca", "Canada"],
  ["au", "Australia"], ["de", "Germany"], ["fr", "France"], ["jp", "Japan"],
  ["br", "Brazil"], ["mx", "Mexico"], ["es", "Spain"], ["it", "Italy"],
];
