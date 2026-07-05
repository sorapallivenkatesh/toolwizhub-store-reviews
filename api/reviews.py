"""
StoreReviews API — fetch & normalize App Store + Play Store reviews.

One endpoint:  GET /reviews?store=appstore|play&id=<id>&country=<cc>&lang=<ll>&limit=<n>
  - appstore: id = numeric App Store id (e.g. 618783545)
  - play:     id = package name (e.g. com.whatsapp)

Returns:
  { "app": {name, icon, version, ratingCount, avgRating},
    "reviews": [{id, author, title, text, rating, version, date, store}],
    "throttled": bool }

Apple is read via its public RSS + Lookup (stdlib urllib — no CORS worry server-side).
Play is read via google-play-scraper. Results are cached in-memory per warm container
(TTL) so repeated/global requests don't hammer the stores (the reason for a backend).
"""

import json
import logging
import os
import time
import urllib.request
import urllib.error

CACHE_TTL = 600          # seconds a fetched result is reused
_CACHE = {}              # key -> (expires_at, payload)

logger = logging.getLogger("store-reviews")
if not logger.handlers:  # Lambda pre-installs a root handler; locally add our own.
    logging.basicConfig()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())


def _cors():
    # ALLOW_ORIGIN is set by template.yaml in prod; dev.py leaves it "*".
    return {
        "Access-Control-Allow-Origin": os.environ.get("ALLOW_ORIGIN", "*"),
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
    }


def _resp(status, body):
    return {"statusCode": status, "headers": _cors(), "body": json.dumps(body)}


def _http_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "ToolWizHub-StoreReviews/1.0 (+https://store-reviews.toolwizhub.com)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=9) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


# ── App Store ────────────────────────────────────────────────────────────────
def _apple_lookup(app_id, country):
    try:
        d = _http_json(f"https://itunes.apple.com/lookup?id={app_id}&country={country}")
        r = (d.get("results") or [None])[0]
        if not r:
            return {}
        return {
            "name": r.get("trackName", "App"),
            "icon": r.get("artworkUrl512") or r.get("artworkUrl100", ""),
            "version": r.get("version", ""),
            "ratingCount": r.get("userRatingCount", 0),
            "avgRating": round(r.get("averageUserRating", 0) or 0, 2),
            "histogram": None,  # Apple publishes no public star breakdown
        }
    except Exception:
        return {}


def _apple_reviews(app_id, country, max_pages):
    seen, reviews = set(), []
    throttled = False
    for page in range(1, max_pages + 1):
        url = (f"https://itunes.apple.com/{country}/rss/customerreviews/"
               f"page={page}/id={app_id}/sortby=mostrecent/json")
        try:
            feed = (_http_json(url) or {}).get("feed", {})
        except Exception:
            if page == 1:
                raise
            break
        entries = feed.get("entry")
        entries = entries if isinstance(entries, list) else ([entries] if entries else [])
        added = 0
        for e in entries:
            if not e.get("im:rating"):   # the app-metadata entry has no rating
                continue
            rid = (e.get("id", {}) or {}).get("label", "")
            if rid in seen:
                continue
            seen.add(rid)
            reviews.append({
                "id": rid,
                "author": (e.get("author", {}).get("name", {}) or {}).get("label", "Anonymous"),
                "title": (e.get("title", {}) or {}).get("label", ""),
                "text": (e.get("content", {}) or {}).get("label", ""),
                "rating": int((e.get("im:rating", {}) or {}).get("label", "0") or 0),
                "version": (e.get("im:version", {}) or {}).get("label", ""),
                "date": (e.get("updated", {}) or {}).get("label", ""),
                "store": "appstore",
            })
            added += 1
        if added == 0:
            if page == 1:
                throttled = True   # empty first page ⇒ Apple is rate-limiting this IP
            break
        time.sleep(0.15)           # be gentle with Apple
    return reviews, throttled


def fetch_appstore(app_id, country, limit):
    meta = _apple_lookup(app_id, country)
    # Apple serves ~50 reviews/page and caps at 10 pages; ceil-divide to cover `limit`.
    pages = max(1, min(10, -(-limit // 50)))
    reviews, throttled = _apple_reviews(app_id, country, max_pages=pages)
    reviews = reviews[:limit]
    if not meta:
        meta = {"name": "App", "icon": "", "version": "", "ratingCount": 0, "avgRating": 0, "histogram": None}
    return {"app": meta, "reviews": reviews, "throttled": throttled and not reviews}


# ── Play Store ───────────────────────────────────────────────────────────────
def fetch_play(package, country, lang, limit):
    from google_play_scraper import app as gp_app, reviews as gp_reviews, Sort
    info = gp_app(package, lang=lang, country=country)
    # scraper batches in ~50s; fetch at least that, then trim to the caller's limit.
    result, _ = gp_reviews(package, lang=lang, country=country, sort=Sort.NEWEST, count=min(500, max(50, limit)))
    reviews = []
    for r in result[:limit]:
        at = r.get("at")
        reviews.append({
            "id": r.get("reviewId", ""),
            "author": r.get("userName", "Anonymous"),
            "title": "",
            "text": r.get("content", "") or "",
            "rating": int(r.get("score", 0) or 0),
            "version": r.get("reviewCreatedVersion") or "",
            "date": at.isoformat() if hasattr(at, "isoformat") else str(at or ""),
            "store": "play",
        })
    hist = info.get("histogram")  # [1★, 2★, 3★, 4★, 5★] counts, store-wide
    meta = {
        "name": info.get("title", "App"),
        "icon": info.get("icon", ""),
        "version": info.get("version", "") or "",
        "ratingCount": info.get("ratings", 0) or 0,
        "avgRating": round(info.get("score", 0) or 0, 2),
        "histogram": hist if isinstance(hist, list) and len(hist) == 5 else None,
    }
    return {"app": meta, "reviews": reviews, "throttled": False}


# ── Handler ──────────────────────────────────────────────────────────────────
def handler(event, context):
    started = time.time()
    method = (event.get("requestContext", {}).get("http", {}) or {}).get("method") \
        or event.get("httpMethod") or "GET"
    if method == "OPTIONS":
        return {"statusCode": 204, "headers": _cors(), "body": ""}

    q = event.get("queryStringParameters") or {}
    store = (q.get("store") or "appstore").lower()
    app_id = (q.get("id") or "").strip()
    country = (q.get("country") or "us").lower()[:2]
    lang = (q.get("lang") or "en").lower()[:2]
    try:
        limit = int(q.get("limit") or 200)
    except ValueError:
        limit = 200

    logger.info("request store=%s id=%s country=%s lang=%s limit=%s", store, app_id, country, lang, limit)

    if not app_id:
        logger.warning("400 missing id")
        return _resp(400, {"error": "Missing 'id'."})
    if store not in ("appstore", "play"):
        logger.warning("400 bad store=%s", store)
        return _resp(400, {"error": "store must be 'appstore' or 'play'."})

    key = f"{store}:{app_id}:{country}:{lang}:{limit}"
    hit = _CACHE.get(key)
    if hit and hit[0] > time.time():
        out = dict(hit[1]); out["cached"] = True
        logger.info("cache HIT key=%s reviews=%d in %dms", key, len(out.get("reviews", [])),
                    int((time.time() - started) * 1000))
        return _resp(200, out)

    try:
        data = fetch_appstore(app_id, country, limit) if store == "appstore" \
            else fetch_play(app_id, country, lang, limit)
    except Exception as e:
        logger.exception("502 fetch failed store=%s id=%s", store, app_id)
        return _resp(502, {"error": f"Could not fetch {store} reviews.", "detail": str(e)[:200]})

    data["cached"] = False
    _CACHE[key] = (time.time() + CACHE_TTL, data)
    logger.info("cache MISS key=%s app=%r reviews=%d throttled=%s in %dms", key,
                (data.get("app") or {}).get("name"), len(data.get("reviews", [])),
                data.get("throttled"), int((time.time() - started) * 1000))
    return _resp(200, data)
