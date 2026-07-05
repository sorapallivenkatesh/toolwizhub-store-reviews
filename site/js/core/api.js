/* core/api.js — client for the StoreReviews backend (App Store + Play Store).
   API_BASE comes from site/config.js (window.TWH), which auto-picks localhost:3001
   in dev and the deployed API in prod. When it resolves empty, the App Store still
   works client-side (Apple RSS fallback in app.js); the Play Store requires this API. */

export const API_BASE =
  (typeof window !== "undefined" && window.TWH && window.TWH.API_BASE) || "";

export function hasApi() { return !!API_BASE; }

/** GET /reviews → { app:{name,icon,version,ratingCount,avgRating}, reviews:[…], throttled, cached } */
export async function apiFetch(store, id, country = "us", lang = "en", limit = 500) {
  if (!API_BASE) throw new Error("API not configured");
  const url = `${API_BASE}/reviews?store=${encodeURIComponent(store)}&id=${encodeURIComponent(id)}`
    + `&country=${encodeURIComponent(country)}&lang=${encodeURIComponent(lang)}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([data.error, data.detail].filter(Boolean).join(" — ") || `HTTP ${res.status}`);
  return data;
}

/** Extract a Play package name from a Play URL or raw string ("com.example.app"). */
export function parsePlayId(input) {
  const s = String(input || "").trim();
  const m = s.match(/[?&]id=([\w.]+)/) || s.match(/^([a-z][\w]*(?:\.[\w]+)+)$/i);
  return m ? m[1] : null;
}
