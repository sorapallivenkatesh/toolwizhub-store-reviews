/* core/triage.js — PURE review-triage logic. No DOM, no network, no storage.
   Independently testable in Node. Given a review {rating, title, text, version, date}
   it derives sentiment, category tags, a priority score, and can cluster reviews. */

/* ── Category rules (first match order doesn't matter — a review can carry several) ── */
export const CATEGORIES = [
  { id: "crash",   label: "Crash / Bug",     kw: ["crash","crashes","crashing","freeze","frozen","bug","broken","doesn't work","not working","stopped working","force close","glitch","error","fails","failed","stuck"] },
  { id: "dataloss",label: "Data loss / Sync",kw: ["lost data","lost my","deleted everything","disappeared","not saving","won't sync","sync issue","out of sync","gone missing","lost all"] },
  { id: "auth",    label: "Login / Auth",    kw: ["can't log in","cannot login","can't sign in","login","log in","sign in","password","otp","verification","locked out","2fa","authenticate"] },
  { id: "payment", label: "Payment / IAP",   kw: ["charged","refund","subscription","subscribed","paid","payment","billing","overcharged","charged twice","in-app purchase","restore purchase","price","expensive","money back"] },
  { id: "perf",    label: "Performance",     kw: ["slow","lag","laggy","battery","drain","heats","overheat","memory","ram","hangs","sluggish","takes forever","loading"] },
  { id: "ads",     label: "Ads",             kw: ["ad","ads","advert","too many ads","popup","pop-up","commercial"] },
  { id: "ux",      label: "UX / Design",     kw: ["ui","ux","design","confusing","hard to use","cluttered","layout","dark mode","theme","font","button","navigation","clunky"] },
  { id: "feature", label: "Feature request", kw: ["please add","wish","would be nice","feature request","should add","hope you add","need an option","add support","allow us","can you add","suggestion","would love"] },
  { id: "notif",   label: "Notifications",   kw: ["notification","notifications","push","alert","reminder","doesn't notify","no alert"] },
  { id: "l10n",    label: "Localization",    kw: ["language","translation","translate","not in my language","localization","español","हिंदी"] },
  { id: "support", label: "Support request", kw: ["help","support","contact","no response","customer service","how do i","how to"] },
  { id: "praise",  label: "Praise",          kw: ["love","great","awesome","amazing","excellent","best app","perfect","fantastic","wonderful","thank you","brilliant","superb","life saver","lifesaver"] },
  { id: "spam",    label: "Spam / Off-topic",kw: ["first","follow me","promo code","check out my","subscribe to","http://","https://","www."] },
];

/* words that push priority up regardless of category */
const HIGH_SIGNAL = ["crash","charged twice","lost data","lost my","can't log in","cannot login","data loss","refund","unusable","broken","scam","fraud","stopped working","deleted everything","won't open","can't open","hacked","security"];

const POS = ["love","great","awesome","amazing","excellent","perfect","fantastic","wonderful","good","nice","best","brilliant","superb","easy","helpful","recommend","smooth","beautiful","fast","reliable","thank","glad","happy","works well","works great"];
const NEG = ["hate","terrible","awful","worst","bad","horrible","useless","broken","crash","bug","annoying","disappointed","disappointing","frustrating","slow","waste","scam","fraud","angry","poor","unusable","garbage","trash","ridiculous","fix this","stopped","won't","can't","doesn't","not working","fails","error","refund"];
const NEGATORS = ["not","no","never","don't","doesn't","didn't","can't","cannot","won't"];

const norm = (s) => (s || "").toLowerCase();
const words = (s) => norm(s).replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);

/** Lexicon sentiment on the review text (independent of star rating). → "positive"|"neutral"|"negative" + score. */
export function sentiment(text) {
  const t = " " + norm(text) + " ";
  const toks = words(text);
  let score = 0;
  const hit = (list, weight) => {
    for (const term of list) {
      if (term.includes(" ")) { if (t.includes(" " + term + " ") || t.includes(term)) score += weight; }
      else {
        const i = toks.indexOf(term);
        if (i >= 0) score += weight * (i > 0 && NEGATORS.includes(toks[i - 1]) ? -1 : 1);
      }
    }
  };
  hit(POS, 1); hit(NEG, -1);
  const label = score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
  return { label, score };
}

/** Assign category ids to a review (based on title + text).
   Single alphabetic keywords match whole words (so "add" ≠ "ad"); phrases and
   keywords with punctuation (e.g. "can't log in", "http://") match as substrings. */
export function categorize(text) {
  const t = norm(text);
  const toks = new Set(words(text));
  const isPhrase = (k) => /[^a-z]/.test(k); // space, apostrophe, slash, etc.
  const tags = [];
  for (const c of CATEGORIES) {
    if (c.kw.some((k) => (isPhrase(k) ? t.includes(k) : toks.has(k)))) tags.push(c.id);
  }
  // praise shouldn't co-exist with hard problems; if bug/crash present, drop praise
  if (tags.includes("crash") || tags.includes("dataloss")) {
    const i = tags.indexOf("praise"); if (i >= 0) tags.splice(i, 1);
  }
  return tags.length ? tags : ["other"];
}

/** Days between a review date (ms or ISO) and `now` (ms). */
function ageDays(date, now) {
  const t = typeof date === "number" ? date : Date.parse(date);
  if (!t) return 999;
  return Math.max(0, (now - t) / 86400000);
}

/**
 * Priority 0–100. Higher = triage sooner.
 * Low stars + negative text + high-signal words + recent + (optionally) affecting the latest version.
 */
export function priority(review, opts = {}) {
  const now = opts.now || Date.now();
  const latestVersion = opts.latestVersion || null;
  const text = `${review.title || ""} ${review.text || ""}`;
  const sent = review._sentiment || sentiment(text);
  const t = norm(text);

  let p = 0;
  const rating = Number(review.rating) || 0;
  p += rating <= 1 ? 42 : rating === 2 ? 34 : rating === 3 ? 20 : rating === 4 ? 6 : 0;   // stars
  p += sent.score < 0 ? Math.min(22, -sent.score * 6) : 0;                                 // negative text
  p += HIGH_SIGNAL.reduce((a, k) => a + (t.includes(k) ? 12 : 0), 0);                       // scary keywords
  const age = ageDays(review.date, now);
  p += age <= 7 ? 14 : age <= 30 ? 8 : age <= 90 ? 3 : 0;                                    // recency
  if (latestVersion && review.version && review.version === latestVersion) p += 8;          // hits current build
  return Math.max(0, Math.min(100, Math.round(p)));
}

export function priorityLabel(p) {
  return p >= 60 ? "critical" : p >= 40 ? "high" : p >= 20 ? "medium" : "low";
}

/** Enrich a list of raw reviews with _sentiment, categories, priority (mutates copies). */
export function triage(reviews, opts = {}) {
  const now = opts.now || Date.now();
  const latestVersion = opts.latestVersion || latestVer(reviews);
  return reviews.map((r) => {
    const text = `${r.title || ""} ${r.text || ""}`;
    const sent = sentiment(text);
    const cats = categorize(text);
    const pr = priority({ ...r, _sentiment: sent }, { now, latestVersion });
    return { ...r, sentiment: sent.label, sentimentScore: sent.score, categories: cats, priority: pr, priorityLabel: priorityLabel(pr) };
  });
}

/** Highest semver-ish version string present. */
export function latestVer(reviews) {
  const cmp = (a, b) => {
    const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0); }
    return 0;
  };
  let best = null;
  for (const r of reviews) { if (r.version && (best === null || cmp(r.version, best) > 0)) best = r.version; }
  return best;
}

/** Simple theme clusters: group by shared significant keywords → {label, count, ids, avgRating}. */
const STOP = new Set("the a an and or but is are was were be been to of in on for with it this that i you we they my your app not no so very just really".split(" "));
export function cluster(reviews, minSize = 2) {
  const buckets = new Map(); // keyword -> [review]
  for (const r of reviews) {
    const seen = new Set();
    for (const w of words(`${r.title || ""} ${r.text || ""}`)) {
      if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      if (!buckets.has(w)) buckets.set(w, []);
      buckets.get(w).push(r);
    }
  }
  const clusters = [...buckets.entries()]
    .filter(([, arr]) => arr.length >= minSize)
    .map(([kw, arr]) => ({
      label: kw,
      count: arr.length,
      ids: arr.map((r) => r.id),
      avgRating: +(arr.reduce((a, r) => a + (Number(r.rating) || 0), 0) / arr.length).toFixed(1),
    }))
    .sort((a, b) => b.count - a.count);
  return clusters;
}

/** Aggregate stats for the dashboard. */
export function stats(reviews) {
  const total = reviews.length;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0, pos = 0, neg = 0, neu = 0, responded = 0;
  const catCount = {};
  for (const r of reviews) {
    const st = Math.min(5, Math.max(1, Math.round(Number(r.rating) || 0)));
    dist[st] = (dist[st] || 0) + 1; sum += Number(r.rating) || 0;
    if (r.sentiment === "positive") pos++; else if (r.sentiment === "negative") neg++; else neu++;
    if (r.devResponse) responded++;
    for (const c of (r.categories || [])) catCount[c] = (catCount[c] || 0) + 1;
  }
  return { total, avg: total ? +(sum / total).toFixed(2) : 0, dist, pos, neg, neu, responded, catCount };
}
