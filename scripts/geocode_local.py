#!/usr/bin/env python3
"""
Geocode and populate lat/lng for a local SQLite attractions DB.

- Ensures attractions.lat/lng columns exist (REAL).
- For rows missing lat/lng, tries providers in order:
  1) Country‑specific free providers (e.g., Amap for China if AMAP_KEY is set).
  2) Free, no‑key providers: Photon (komoot), Open‑Meteo Geocoding.
  3) Nominatim with countrycodes/viewbox + backoff.
  4) Optional key‑based free tiers if keys exist: OpenCage, Geoapify, LocationIQ, MapQuest, Positionstack, Google.

Usage examples:
  python travelPlacesServer/scripts/geocode_local.py --db path/to/japan.db --country japan
  python travelPlacesServer/scripts/geocode_local.py --db path/to/usa.db --country us

Notes:
  - Respect Nominatim usage policy. Default delay ~1.1s/request.
  - Some providers require an API key set via env vars (used automatically if present):
    AMAP_KEY, OPENCAGE_KEY, GEOAPIFY_KEY, LOCATIONIQ_KEY, MAPQUEST_KEY, POSITIONSTACK_KEY, GOOGLE_MAPS_API_KEY
"""

import argparse
import os
import re
import sqlite3
import sys
import time
from typing import Optional, Tuple, List
from datetime import datetime

try:
    import requests
except ImportError:
    print("Missing dependency: requests. Install with: pip install requests", file=sys.stderr)
    sys.exit(1)


def ensure_columns(conn: sqlite3.Connection, table: str = "attractions") -> None:
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table})")
    cols = {row[1].lower() for row in cur.fetchall()}
    if "lat" not in cols:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN lat REAL")
    if "lng" not in cols:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN lng REAL")
    if "geo_source" not in cols:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN geo_source TEXT")
    if "geo_query" not in cols:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN geo_query TEXT")
    if "geo_updated_at" not in cols:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN geo_updated_at TEXT")
    conn.commit()


def parse_lat_lng_from_position(position: Optional[str]) -> Optional[Tuple[float, float]]:
    if not position:
        return None
    s = str(position)
    # Common patterns: "lat, lng" or "lat:.., lng:.."
    m = re.search(r"(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)", s)
    if not m:
        return None
    try:
        lat = float(m.group(1))
        lng = float(m.group(2))
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
            return None
        return lat, lng
    except Exception:
        return None


def geocode_nominatim(query: str, *, lang: str = "zh-CN,en", ua: str = "travelplaces-local/1.0") -> Optional[Tuple[float, float]]:
    url = "https://nominatim.openstreetmap.org/search"
    params = {"format": "json", "q": query}
    headers = {"User-Agent": ua, "Accept-Language": lang}
    try:
        r = requests.get(url, params=params, headers=headers, timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
        if not isinstance(data, list) or not data:
            return None
        first = data[0]
        lat = float(first.get("lat"))
        lng = float(first.get("lon"))
        return lat, lng
    except Exception:
        return None


def geocode_google(query: str, *, country: Optional[str], api_key: str) -> Optional[Tuple[float, float]]:
    url = "https://maps.googleapis.com/maps/api/geocode/json"
    params = {"address": query, "key": api_key}
    # Optional country component (e.g., us/jp/cn or full name)
    if country:
        params["components"] = f"country:{country}"
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        if data.get("status") != "OK":
            return None
        results = data.get("results") or []
        if not results:
            return None
        loc = (((results[0] or {}).get("geometry") or {}).get("location"))
        if not loc:
            return None
        return float(loc["lat"]), float(loc["lng"])
    except Exception:
        return None


# ---------- Enhancements: additional providers and strategies ----------

COUNTRY_BBOX = {
    "cn": (73.5, 18.0, 134.8, 53.6),
    "china": (73.5, 18.0, 134.8, 53.6),
    "us": (-124.8, 24.4, -66.9, 49.4),
    "usa": (-124.8, 24.4, -66.9, 49.4),
    "jp": (122.9, 24.0, 153.0, 46.0),
    "japan": (122.9, 24.0, 153.0, 46.0),
}


def geocode_nominatim_scoped(query: str, country: str = "", lang: str = "zh-CN,zh,en", max_retries: int = 3) -> Optional[Tuple[float, float]]:
    url = "https://nominatim.openstreetmap.org/search"
    params = {"format": "json", "q": query, "limit": 1}
    if country:
        params["countrycodes"] = country.lower()[:2]
        if country.lower() in COUNTRY_BBOX:
            minx, miny, maxx, maxy = COUNTRY_BBOX[country.lower()]
            params["viewbox"] = f"{minx},{maxy},{maxx},{miny}"
            params["bounded"] = 1
    headers = {"User-Agent": "travelplaces-local/1.0", "Accept-Language": lang}
    delay = 1.1
    for _ in range(max_retries):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=20)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and data:
                    return float(data[0]["lat"]), float(data[0]["lon"])
                return None
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(delay)
                delay *= 2
            else:
                return None
        except Exception:
            time.sleep(delay)
            delay *= 2
    return None


def geocode_photon(query: str, lang: str = "en") -> Optional[Tuple[float, float]]:
    # Photon by Komoot (no key). Keep rate modest.
    url = "https://photon.komoot.io/api/"
    params = {"q": query, "limit": 1, "lang": lang}
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        feats = (data.get("features") or [])
        if not feats:
            return None
        coords = ((feats[0] or {}).get("geometry") or {}).get("coordinates")
        if not coords or len(coords) < 2:
            return None
        lng, lat = coords[0], coords[1]
        return float(lat), float(lng)
    except Exception:
        return None


def geocode_open_meteo(query: str, lang: str = "en") -> Optional[Tuple[float, float]]:
    # Open‑Meteo Geocoding (no key)
    url = "https://geocoding-api.open-meteo.com/v1/search"
    params = {"name": query, "count": 1, "language": lang}
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        results = data.get("results") or []
        if not results:
            return None
        first = results[0]
        return float(first.get("latitude")), float(first.get("longitude"))
    except Exception:
        return None


def geocode_opencage(query: str, key: str, country: Optional[str]) -> Optional[Tuple[float, float]]:
    url = "https://api.opencagedata.com/geocode/v1/json"
    params = {"q": query, "key": key, "limit": 1}
    if country:
        params["countrycode"] = country.lower()[:2]
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        results = data.get("results") or []
        if not results:
            return None
        g = ((results[0] or {}).get("geometry") or {})
        lat, lng = g.get("lat"), g.get("lng")
        if lat is None or lng is None:
            return None
        return float(lat), float(lng)
    except Exception:
        return None


def geocode_geoapify(query: str, key: str, country: Optional[str]) -> Optional[Tuple[float, float]]:
    url = "https://api.geoapify.com/v1/geocode/search"
    params = {"text": query, "limit": 1, "apiKey": key}
    if country:
        params["filter"] = f"countrycode:{country.lower()[:2]}"
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        feats = (data.get("features") or [])
        if not feats:
            return None
        coords = ((feats[0] or {}).get("geometry") or {}).get("coordinates")
        if not coords or len(coords) < 2:
            return None
        lng, lat = coords[0], coords[1]
        return float(lat), float(lng)
    except Exception:
        return None


def geocode_locationiq(query: str, key: str, country: Optional[str]) -> Optional[Tuple[float, float]]:
    url = "https://us1.locationiq.com/v1/search"
    params = {"q": query, "key": key, "format": "json", "limit": 1}
    if country:
        params["countrycodes"] = country.lower()[:2]
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
        if not isinstance(data, list) or not data:
            return None
        first = data[0]
        return float(first.get("lat")), float(first.get("lon"))
    except Exception:
        return None


def geocode_mapquest(query: str, key: str, country: Optional[str]) -> Optional[Tuple[float, float]]:
    url = "https://www.mapquestapi.com/geocoding/v1/address"
    params = {"key": key, "location": query, "maxResults": 1}
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        results = data.get("results") or []
        if not results:
            return None
        locs = ((results[0] or {}).get("locations") or [])
        if not locs:
            return None
        latlng = (locs[0] or {}).get("latLng") or {}
        lat, lng = latlng.get("lat"), latlng.get("lng")
        if lat is None or lng is None:
            return None
        return float(lat), float(lng)
    except Exception:
        return None


def geocode_positionstack(query: str, key: str, country: Optional[str]) -> Optional[Tuple[float, float]]:
    url = "http://api.positionstack.com/v1/forward"
    params = {"access_key": key, "query": query, "limit": 1}
    if country:
        params["country"] = country
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        d = (data.get("data") or [])
        if not d:
            return None
        first = d[0]
        lat, lng = first.get("latitude"), first.get("longitude")
        if lat is None or lng is None:
            return None
        return float(lat), float(lng)
    except Exception:
        return None


def _out_of_china(lat, lng):
    return not (0.8293 <= lat <= 55.8271 and 72.004 <= lng <= 137.8347)


def _transform_lat(x, y):
    import math
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x, y):
    import math
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def gcj02_to_wgs84(lat, lng):
    import math
    if _out_of_china(lat, lng):
        return lat, lng
    a = 6378245.0
    ee = 0.00669342162296594323
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * math.pi)
    mglat = lat + dlat
    mglng = lng + dlng
    return lat - dlat, lng - dlng


def geocode_amap(query: str, key: str, city: str = "") -> Optional[Tuple[float, float]]:
    url = "https://restapi.amap.com/v3/geocode/geo"
    params = {"key": key, "address": query, "output": "JSON"}
    if city:
        params["city"] = city
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        if data.get("status") != "1" or not data.get("geocodes"):
            return None
        loc = data["geocodes"][0].get("location", "")
        if not loc or "," not in loc:
            return None
        lng, lat = map(float, loc.split(","))
        return gcj02_to_wgs84(lat, lng)
    except Exception:
        return None


def geocode_amap_place(query: str, key: str, city: str = "") -> Optional[Tuple[float, float]]:
    """AMap Place Text Search (better for POIs than address geocode). Returns WGS84.
    API: https://restapi.amap.com/v3/place/text
    """
    url = "https://restapi.amap.com/v3/place/text"
    params = {
        "key": key,
        "keywords": query,
        "offset": 1,
        "page": 1,
        "extensions": "base",
        "output": "JSON",
    }
    if city:
        params["city"] = city
        params["citylimit"] = "true"
    try:
        r = requests.get(url, params=params, timeout=15)
        if r.status_code != 200:
            return None
        data = r.json() or {}
        if data.get("status") != "1":
            return None
        pois = data.get("pois") or []
        if not pois:
            return None
        loc = (pois[0] or {}).get("location") or ""
        if not loc or "," not in loc:
            return None
        lng, lat = map(float, loc.split(","))
        return gcj02_to_wgs84(lat, lng)
    except Exception:
        return None


def strip_noise(text: str) -> str:
    if not text:
        return ""
    s = str(text)
    # remove urls
    s = re.sub(r"https?://\S+", " ", s)
    # remove parentheses content
    s = re.sub(r"[\(（][^\)）]*[\)）]", " ", s)
    # remove emojis/non-word
    s = re.sub(r"[\u2600-\u27FF\U0001F300-\U0001FAD6]", " ", s)
    # collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()
    return s


def has_cjk(s: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def build_queries(position: Optional[str], name: Optional[str], region: Optional[str], county: Optional[str], country: Optional[str]) -> List[str]:
    parts_base = [strip_noise(x) for x in [name, region, county, country] if x]
    q_full = " ".join(parts_base)
    out: List[str] = []
    if position:
        out.append(strip_noise(position))
    if q_full:
        out.append(q_full)
    # progressively relax
    if name and country:
        out.append(f"{strip_noise(name)} {strip_noise(country)}")
    if name and region:
        out.append(f"{strip_noise(name)} {strip_noise(region)} {strip_noise(country or '')}")
    # domain-specific suffixes
    if has_cjk(q_full):
        for suf in ("景点", "公园", "博物馆", "风景区"):
            out.append(f"{q_full} {suf}")
    else:
        for suf in ("tourist attraction", "park", "museum", "scenic area"):
            out.append(f"{q_full} {suf}")
    # dedupe while preserving order
    seen = set()
    uniq = []
    for q in out:
        if q and q not in seen:
            seen.add(q)
            uniq.append(q)
    return uniq


def main():
    ap = argparse.ArgumentParser(description="Populate lat/lng for local attractions SQLite DB")
    ap.add_argument("--db", required=True, help="Path to local .db file")
    ap.add_argument("--country", default="", help="Country code/name to aid geocoding (optional)")
    ap.add_argument("--google-key", default=os.environ.get("GOOGLE_MAPS_API_KEY", ""), help="Google Maps Geocoding API key (optional)")
    ap.add_argument("--sleep-ms", type=int, default=1100, help="Delay between requests (ms). Respect Nominatim policy")
    ap.add_argument("--limit", type=int, default=0, help="Max rows to process (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="Do not write changes")
    args = ap.parse_args()

    if not os.path.isfile(args.db):
        print(f"DB not found: {args.db}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(args.db)
    try:
        ensure_columns(conn)

        cur = conn.cursor()
        cur.execute(
            "SELECT id, name, region, county, position, lat, lng FROM attractions WHERE lat IS NULL OR lng IS NULL"
        )
        rows = cur.fetchall()
        total = len(rows)
        if args.limit and total > args.limit:
            rows = rows[: args.limit]
        print(f"Pending rows: {len(rows)} (of {total})")

        updated = 0
        failed = 0
        contact = os.environ.get("CONTACT_EMAIL") or os.environ.get("CONTACT_URL") or "local"
        ua = f"travelplaces-local/1.0 (+{contact})"
        # keys (optional)
        key_amap = os.environ.get("AMAP_KEY", "")
        key_opencage = os.environ.get("OPENCAGE_KEY", "")
        key_geoapify = os.environ.get("GEOAPIFY_KEY", "")
        key_locationiq = os.environ.get("LOCATIONIQ_KEY", "")
        key_mapquest = os.environ.get("MAPQUEST_KEY", "")
        key_positionstack = os.environ.get("POSITIONSTACK_KEY", "")
        key_google = args.google_key or os.environ.get("GOOGLE_MAPS_API_KEY", "")
        is_cn = (args.country or "").lower() in ("cn", "china")
        small_pause = 0.2
        def lang_for(country: str) -> str:
            c = (country or "").lower()
            if c in ("cn", "china"):
                return "zh-CN,zh,en"
            return "en"

        for i, (rid, name, region, county, position, lat, lng) in enumerate(rows, 1):
            sys.stdout.write(f"[{i}/{len(rows)}] id={rid}: ")
            sys.stdout.flush()

            # Build queries and try providers
            used = None
            used_query = None
            queries = build_queries(position, name, region, county, args.country)
            ll = None
            for q in queries:
                    # For CN queries written in non‑CJK, try appending 中国 as a variant
                    try_variants = [q]
                    if is_cn and not has_cjk(q):
                        try_variants.append(q + " 中国")

                    # pick city param only when it's likely Chinese/adcode
                    city_param = region or county or ""
                    if city_param and not has_cjk(city_param):
                        city_param = ""

                    for qv in try_variants:
                        # For China: prefer Amap first if key provided
                        if is_cn and key_amap and not ll:
                            # Prefer address geocode first
                            ll = geocode_amap(qv, key_amap, city=city_param)
                            if ll:
                                used = "amap_geocode"
                                used_query = qv
                                break
                            time.sleep(small_pause)
                            # Fallback to POI text search
                            ll = geocode_amap_place(qv, key_amap, city=city_param)
                            if ll:
                                used = "amap_place"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        #google first

                        if not ll and key_google:
                            ll = geocode_google(qv, country=args.country, api_key=key_google)
                            if ll:
                                used = "google"
                                used_query = qv
                                break
                            time.sleep(small_pause)


                        # No-key providers
                        if not ll:
                            ll = geocode_photon(qv, lang=("zh" if is_cn else "en"))
                            if ll:
                                used = "photon"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        if not ll:
                            ll = geocode_open_meteo(qv, lang=("zh" if is_cn else "en"))
                            if ll:
                                used = "open-meteo"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        # Scoped Nominatim (with backoff inside)
                        if not ll:
                            ll = geocode_nominatim_scoped(qv, country=args.country, lang=lang_for(args.country))
                            if ll:
                                used = "nominatim"
                                used_query = qv
                                break

                        # Optional key-based free tiers (if keys present)
                        if not ll and key_opencage:
                            ll = geocode_opencage(qv, key_opencage, args.country)
                            if ll:
                                used = "opencage"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        if not ll and key_geoapify:
                            ll = geocode_geoapify(qv, key_geoapify, args.country)
                            if ll:
                                used = "geoapify"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        if not ll and key_locationiq:
                            ll = geocode_locationiq(qv, key_locationiq, args.country)
                            if ll:
                                used = "locationiq"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        if not ll and key_mapquest:
                            ll = geocode_mapquest(qv, key_mapquest, args.country)
                            if ll:
                                used = "mapquest"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        if not ll and key_positionstack:
                            ll = geocode_positionstack(qv, key_positionstack, args.country)
                            if ll:
                                used = "positionstack"
                                used_query = qv
                                break
                            time.sleep(small_pause)

                        # (Amap already tried first for CN)

                    if ll:
                        break

            if not ll:
                failed += 1
                print("fail")
                time.sleep(args.sleep_ms / 1000.0)
                continue

            lat_v, lng_v = ll
            src = used or "unknown"
            print(f"[{src}] ok -> {lat_v:.6f},{lng_v:.6f}")

            if not args.dry_run:
                cur.execute(
                    "UPDATE attractions SET lat = ?, lng = ?, geo_source = ?, geo_query = ?, geo_updated_at = ? WHERE id = ?",
                    (lat_v, lng_v, src, used_query or "", datetime.utcnow().isoformat(timespec='seconds') + 'Z', rid),
                )
                updated += 1

            # rate-limit across rows (Nominatim policy)
            time.sleep(args.sleep_ms / 1000.0)

        if not args.dry_run:
            conn.commit()
        print(f"Done. updated={updated}, failed={failed}")
    finally:
        conn.close()


if __name__ == "__main__":
    # 若直接运行 (例如拖拽 .db 文件到 exe 上)
    if len(sys.argv) == 2 and sys.argv[1].lower().endswith(".db"):
        db_path = sys.argv[1]
        if not os.path.isfile(db_path):
            print(f"数据库文件不存在: {db_path}")
            sys.exit(1)
        # 提取文件名作为国家名（去掉路径和扩展名）
        country = os.path.splitext(os.path.basename(db_path))[0]
        print(f"检测到拖入的数据库文件: {db_path}")
        print(f"自动设置国家名: {country}")
        # 构造伪命令行参数，传给 argparse
        sys.argv = [sys.argv[0], "--db", db_path, "--country", country]

    elif len(sys.argv) == 1:
        print("用法示例：")
        print("  拖动数据库文件到此程序上自动执行")
        print("  或在命令行中手动运行：")
        print("  geocode_local.exe --db path/to/japan.db --country japan")
        sys.exit(0)

    main()
