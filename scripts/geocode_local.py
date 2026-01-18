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
import math
from typing import Optional, Tuple, List
from datetime import datetime

try:
    import requests
except ImportError:
    print("Missing dependency: requests. Install with: pip install requests", file=sys.stderr)
    sys.exit(1)


def has_real_cluster(coords, threshold_km: float = 20.0) -> bool:
    """
    只要 coords 中存在任意一对点的距离 <= threshold_km，就认为“有聚类”。
    否则认为没有聚类。
    """
    if not coords or len(coords) < 2:
        return False
    n = len(coords)
    for i in range(n):
        # coords 可能是 (lat, lng) 或 (lat, lng, api)，这里只取前两个
        lat1, lng1 = coords[i][:2]
        for j in range(i + 1, n):
            lat2, lng2 = coords[j][:2]
            if haversine_distance(lat1, lng1, lat2, lng2) <= threshold_km:
                return True
    return False

def has_real_cluster_single_query(coords, threshold_km=20.0):
    """
    coords: List[(lat, lng)] 对于单个 qv 的所有返回结果
    满足以下任意情况 → 有效聚类
      ✔ 任意两点 < threshold_km   → True
      ❌ 所有两点距离都 > threshold_km → False
    """
    if not coords or len(coords) < 2:
        return False

    n = len(coords)
    for i in range(n):
        # coords 同样可能包含 API 名，只取前两个元素
        lat1, lng1 = coords[i][:2]
        for j in range(i + 1, n):
            lat2, lng2 = coords[j][:2]
            if haversine_distance(lat1, lng1, lat2, lng2) <= threshold_km:
                return True
    return False



def haversine_distance(lat1, lng1, lat2, lng2):
    """Haversine公式计算两点间距离（单位：km）"""
    R = 6371  # 地球半径
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(lat1)) * \
        math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def group_coordinates(coords: List[Tuple[float, float]], threshold_km: float = 20.0):
    """
    将经纬度数据按距离进行聚类（20km以内为同一组）
    返回：[ [组1成员...], [组2成员...], ... ]
    """
    groups = []
    for coord in coords:
        if coord is None or len(coord) < 2:
            continue
        lat, lng = coord[0], coord[1]
        placed = False
        for group in groups:
            # 只需判断与组内第一个成员的距离
            if haversine_distance(lat, lng, group[0][0], group[0][1]) <= threshold_km:
                group.append(coord)
                placed = True
                break
        if not placed:
            groups.append([coord])
    return groups

# Choose best cluster (prefer most members, tie-break by API order when available)
def choose_best_cluster(groups, api_order):
    """
    ?????????
    ???????????? API ????
    """
    # ??????
    groups_sorted = sorted(groups, key=lambda g: -len(g))
    
    # ????????? API ????????
    if len(groups_sorted) > 1 and len(groups_sorted[0]) == len(groups_sorted[1]):
        best_group = min(groups_sorted, key=lambda g: api_order.index(g[0][2]))  # g[0][2] ? API ??
    else:
        best_group = groups_sorted[0]
    
    return best_group

def pick_best_coordinate(coords: List[Tuple[float, float]], api_order):
    """
    ??????????/???
    1) ????????? -> ????????
    2) ?? -> ???????????????? API ??
    3) ??????????
    """
    if not coords:
        return None

    # 1) ?????????????/??
    from collections import Counter
    freq = Counter(coords)
    best_exact = freq.most_common(1)[0]  # ( (lat,lng), count )
    if best_exact[1] > 1:  # ????>1 -> ????
        return best_exact[0]

    # 2) ??
    groups = group_coordinates(coords)  # [[(lat,lng), ...], ...]

    if not groups:
        return None

    # ?????????????????API???
    best_group = choose_best_cluster(groups, api_order)
    avg_lat = sum(c[0] for c in best_group) / len(best_group)
    avg_lng = sum(c[1] for c in best_group) / len(best_group)

    return (avg_lat, avg_lng)

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
        country_code = get_country_code(country)
        params["components"] = f"country:{country_code}"
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

# 国家名称到ISO 3166-1 alpha-2代码的映射
COUNTRY_TO_ISO = {
    "japan": "jp",
    "china": "cn",
    "usa": "us",
    "united states": "us",
    "united states of america": "us",
    "uk": "gb",
    "united kingdom": "gb",
    "great britain": "gb",
    "south korea": "kr",
    "korea": "kr",
    "north korea": "kp",
}

def get_country_code(country: str) -> str:
    """将国家名称转换为ISO 3166-1 alpha-2代码"""
    if not country:
        return ""
    country_lower = country.lower().strip()
    # 如果已经是2位代码，直接返回
    if len(country_lower) == 2:
        return country_lower
    # 查找映射表
    if country_lower in COUNTRY_TO_ISO:
        return COUNTRY_TO_ISO[country_lower]
    # 如果没有映射，尝试取前2位（向后兼容）
    return country_lower[:2]

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
        params["countrycodes"] = get_country_code(country)
        if country.lower() in COUNTRY_BBOX:
            minx, miny, maxx, maxy = COUNTRY_BBOX[country.lower()]
            params["viewbox"] = f"{minx},{maxy},{maxx},{miny}"
            params["bounded"] = 1
    headers = {"User-Agent": "travelplaces-local/1.0", "Accept-Language": lang}
    # 原来 delay=1.1，这里整体降为原来的 1/4
    delay = 1.1 / 4
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

import re

def geocode_wikidata(query: str, country: str = "") -> Optional[Tuple[float, float]]:
    headers = {
        "User-Agent": "travelplaces-local/1.0"
    }

    def normalize(q: str) -> str:
        # 去掉明显的描述性噪声
        q = re.sub(r"about .*", "", q, flags=re.IGNORECASE)
        q = re.sub(r"\b\d+\s*km\b", "", q, flags=re.IGNORECASE)
        q = q.replace(",", " ")
        q = re.sub(r"\s+", " ", q).strip()
        return q

    # 1️⃣ 构造“关键词退化列表”（从长到短）
    base = normalize(query)

    candidates = []
    candidates.append(base)

    # 拆词逐步缩短（非常关键）
    parts = base.split()
    if len(parts) > 3:
        candidates.append(" ".join(parts[:3]))
    if len(parts) > 2:
        candidates.append(" ".join(parts[:2]))
    if len(parts) > 1:
        candidates.append(parts[0])

    # 去重
    candidates = list(dict.fromkeys(candidates))

    for q in candidates:
        try:
            search_resp = requests.get(
                "https://www.wikidata.org/w/api.php",
                params={
                    "action": "wbsearchentities",
                    "search": q,
                    "language": "en",
                    "format": "json",
                    "limit": 5,
                },
                headers=headers,
                timeout=20,
            )

            if search_resp.status_code != 200:
                continue

            results = search_resp.json().get("search", [])
            if not results:
                continue

            for item in results:
                qid = item.get("id")
                if not qid:
                    continue

                entity_resp = requests.get(
                    f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json",
                    headers=headers,
                    timeout=20,
                )
                if entity_resp.status_code != 200:
                    continue

                entity = entity_resp.json()["entities"].get(qid, {})
                claims = entity.get("claims", {})
                coords = claims.get("P625")
                if not coords:
                    continue

                coord = coords[0]["mainsnak"]["datavalue"]["value"]
                return coord["latitude"], coord["longitude"]

        except Exception:
            continue

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
        params["countrycode"] = get_country_code(country)
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
        params["filter"] = f"countrycode:{get_country_code(country)}"
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
        params["countrycodes"] = get_country_code(country)
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
        # Positionstack 接受 ISO 代码或完整国家名称，优先使用 ISO 代码
        params["country"] = get_country_code(country)
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


def cjk_ratio(s: str) -> float:
    """Return share of characters that are CJK Unified Ideographs."""
    if not s:
        return 0.0
    total = len(s)
    cjk_count = sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")
    return cjk_count / total


def build_queries(position: Optional[str], name, region, county, country):
    pos_query = strip_noise(position) if position else None

    parts_base = [strip_noise(x) for x in [name, region, county, country] if x]
    other_queries = []

    if parts_base:
        other_queries.append(" ".join(parts_base))
    if name and country:
        other_queries.append(f"{strip_noise(name)} {strip_noise(country)}")
    if name and region:
        other_queries.append(f"{strip_noise(name)} {strip_noise(region)} {strip_noise(country or '')}")
    # 新增：name + region
    if name and region:
        other_queries.append(f"{strip_noise(name)} {strip_noise(region)}")
    # 新增：单独 name
    if name:
        other_queries.append(strip_noise(name))

    # 去重
    seen = set()
    uniq_other = []
    for q in other_queries:
        if q and q not in seen:
            seen.add(q)
            uniq_other.append(q)

    return pos_query, uniq_other

def lang_for(country: str) -> str:
    c = (country or "").lower()
    if c in ("cn", "china"):
        return "zh-CN,zh,en"
    return "en"


def main():
    
    ap = argparse.ArgumentParser(description="Populate lat/lng for local attractions SQLite DB")
    ap.add_argument("--db", required=True, help="Path to local .db file")
    ap.add_argument("--country", default="", help="Country code/name to aid geocoding (optional)")
    ap.add_argument("--google-key", default=os.environ.get("GOOGLE_MAPS_API_KEY", ""), help="Google Maps Geocoding API key (optional)")
    ap.add_argument("--sleep-ms", type=int, default=1100, help="Delay between requests (ms). Respect Nominatim policy")
    ap.add_argument("--limit", type=int, default=0, help="Max rows to process (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="Do not write changes")
    args = ap.parse_args()

    # ========= API KEY 读取并打印 =========
    key_google       = args.google_key or os.environ.get("GOOGLE_MAPS_API_KEY", "")
    key_amap         = os.environ.get("AMAP_KEY", "")
    key_opencage     = os.environ.get("OPENCAGE_KEY", "")
    key_geoapify     = os.environ.get("GEOAPIFY_KEY", "")
    key_locationiq   = os.environ.get("LOCATIONIQ_KEY", "")
    key_mapquest     = os.environ.get("MAPQUEST_KEY", "")
    key_positionstack= os.environ.get("POSITIONSTACK_KEY", "")

    print("\n======= API KEY 状态 =======")
    print("country        :", args.country or "(none)")
    print("google         :", bool(key_google),       key_google[:6] + "..." if key_google else "")
    print("amap           :", bool(key_amap))
    print("opencage       :", bool(key_opencage))
    print("geoapify       :", bool(key_geoapify))
    print("locationiq     :", bool(key_locationiq))
    print("mapquest       :", bool(key_mapquest))
    print("positionstack  :", bool(key_positionstack))
    print("============================\n")

    # 🔹必须放到 ALL_APIS 之前！
    is_cn = (args.country or "").lower() in ("cn", "china")

    api_order = [
        "google",        # 最高优先级
        "photon",        # 次高优先级
        "open-meteo",    # 中等优先级
        "nominatim",     # 低优先级
        "opencage",      # 更低优先级
        "geoapify",      # 更低优先级
        "locationiq",    # 更低优先级
        "positionstack"  # 最低优先级
        "wikidata"       # 兜底
    ]


    # 统一把 API 放一起管理
    ALL_APIS = [
        # 🔹 国内景点：AMap 优先使用
        ("amap_geocode", lambda q: geocode_amap(q, key_amap, city="")) if (is_cn and key_amap) else None,
        ("amap_place", lambda q: geocode_amap_place(q, key_amap, city="")) if (is_cn and key_amap) else None,

        # 其余 API 统一尝试
        ("google", lambda q: geocode_google(q, country=args.country, api_key=key_google)) if key_google else None,
        ("photon", lambda q: geocode_photon(q, lang=("zh" if is_cn else "en"))),
        ("open-meteo", lambda q: geocode_open_meteo(q, lang=("zh" if is_cn else "en"))),
        ("nominatim", lambda q: geocode_nominatim_scoped(q, country=args.country, lang=lang_for(args.country))),
        ("opencage", lambda q: geocode_opencage(q, key_opencage, args.country)) if key_opencage else None,
        ("geoapify", lambda q: geocode_geoapify(q, key_geoapify, args.country)) if key_geoapify else None,
        ("locationiq", lambda q: geocode_locationiq(q, key_locationiq, args.country)) if key_locationiq else None,
        ("positionstack", lambda q: geocode_positionstack(q, key_positionstack, args.country)) if key_positionstack else None,
        ("wikidata", lambda q: geocode_wikidata(q, args.country)),
    ]
    # 去掉 None
    ALL_APIS = [item for item in ALL_APIS if item]



    if not os.path.isfile(args.db):
        print(f"DB not found: {args.db}", file=sys.stderr)
        input("\n按回车退出...")
        sys.exit(1)

    conn = sqlite3.connect(args.db)
    try:
        ensure_columns(conn)

        cur = conn.cursor()
        cur.execute(
            "SELECT id, name, region, county, position, lat, lng "
            "FROM attractions WHERE lat IS NULL OR lng IS NULL"
        )
        rows = cur.fetchall()
        total = len(rows)
        if args.limit and total > args.limit:
            rows = rows[: args.limit]
        print(f"Pending rows: {len(rows)} (of {total})")

        updated = 0
        failed = 0
        is_cn = (args.country or "").lower() in ("cn", "china")
        # 将短暂停顿时间改为原来的 1/4（原为 0.1）
        small_pause = 0.1 / 4

        for idx, (rid, name, region, county, position, lat, lng) in enumerate(rows, 1):
            print(f"[{idx}/{len(rows)}] id={rid}:")
            pos_coords = []      # 仅 position 查询结果
            other_coords = []    # 其他字段查询结果

            # =============== record 函数分类 ===============
            def record(api_name, result, qv, is_position):
                if result:
                    la, ln = result
                    print(f"  [API:{api_name:12s}] {qv}  ->  {la:.6f}, {ln:.6f}")
                    (pos_coords if is_position else other_coords).append((api_name, la, ln, qv))
                else:
                    print(f"  [API:{api_name:12s}] {qv}  ->  ❌ 无返回结果")

            # =============== 获取查询列表（已去掉 景点/公园 等） ===============
            pos_query, other_queries = build_queries(position, name, region, county, args.country)

            # =============== 🔵 第一阶段：只尝试 position =====================
            pos_coords = []
            other_coords = []
            if pos_query:
                pos_len = len(pos_query)
                pos_cjk_ratio = cjk_ratio(pos_query)
                skip_limit = 10 if pos_cjk_ratio >= 0.5 else 30

                if pos_len < skip_limit:
                    print(f"  [Position Query] length<{skip_limit} (CJK ratio={pos_cjk_ratio:.2f}), skip position stage: {pos_query}")
                else:
                    # CJK 比例较低且长度较长时，去掉 position 中的中文再做地理编码
                    if pos_cjk_ratio < 0.5 and pos_len >= 30:
                        pos_query = re.sub(r"[\u4e00-\u9fff]+", " ", pos_query)
                        pos_query = re.sub(r"\s+", " ", pos_query).strip()
                    print(f"  -- [Position Query] {pos_query}")

                    for api_name, api_func in ALL_APIS:  # 包含 key + 非 key
                        result = api_func(pos_query)
                        record(api_name, result, pos_query, is_position=True)
                        time.sleep(small_pause)

                    # 🧠 检查 position 是否有效
                    pos_only = [(lat, lng, api) for api, lat, lng, _ in pos_coords]
                    pos_ll = pick_best_coordinate(pos_only, api_order)
                    pos_clustered = len(pos_only) >= 2 and has_real_cluster(pos_only, 20.0)

                    # 仅当 position 至少有 2 个结果且形成聚类时，才单独使用 position
                    if pos_ll and pos_clustered:
                        print("  === [position 已确定，不再使用其他字段] ===")
                        final_lat, final_lng = pos_ll
                        src = "position_only"

                        print("  === [position 已确定，不再使用其他字段] ===")
                        print("  🏁 Position 最终选定经纬度 -> "
                            f"{final_lat:.6f}, {final_lng:.6f}")
                        print("  📌 数据源:", src)
                        print("  📌 API 明细:")
                        for api_name, la, ln, qv in pos_coords:
                            print(f"     - {api_name:12s} | {la:.6f}, {ln:.6f} | query={qv}")


                        # 写入数据库
                        if not args.dry_run:
                            cur.execute(
                                "UPDATE attractions SET lat=?,lng=?,geo_source=?,geo_query=?,geo_updated_at=? WHERE id=?",
                                (final_lat, final_lng, src, name or "",
                                datetime.now().isoformat() + 'Z', rid),
                            )
                            updated += 1
                        time.sleep(args.sleep_ms/250.0)
                        continue   # 🚀 直接处理下一行数据！

            # =============== 🟡 第二阶段：尝试其他字段 ======================
            print("  -- [Other Fields Stage]")
            for q in other_queries:
                for api_name, api_func in ALL_APIS:
                    result = api_func(q)
                    record(api_name, result, q, is_position=False)
                    time.sleep(small_pause)

            # =============== position vs other_queries 最终决策 ===============
            from collections import Counter

            # position 所有返回的经纬度
            pos_only = [(lat, lng, api) for api, lat, lng, _ in pos_coords]
            pos_ll = pick_best_coordinate(pos_only, api_order) if pos_only else None

            # other 所有返回的经纬度
            other_only = [(lat, lng, api) for api, lat, lng, _ in other_coords]

            # 按 query 分组统计 other 结果
            query_counts = Counter(qv for _, _, _, qv in other_coords)

            # 🚩 NEW：逐个词条判断是否聚类，并统计“聚类后有效成员数量”
            cluster_info = []  # [(qv, valid_cluster_coords, center_point, valid_count)]

            for qv in query_counts.keys():
                # 获取该词条所有经纬度
                coords_for_qv = [(lat, lng, api) for api, lat, lng, qv2 in other_coords if qv2 == qv]
                if len(coords_for_qv) >= 2:
                    # 先分组
                    groups = group_coordinates(coords_for_qv, threshold_km=20.0)
                    # 选成员最多的那个组
                    groups_sorted = sorted(groups, key=lambda g: -len(g))
                    best_group = groups_sorted[0]

                    # 判断是否形成聚类：该组内至少有两个点且距离 <20km
                    if has_real_cluster_single_query(best_group, 20.0):
                        center_qv = pick_best_coordinate(best_group, api_order)  # 只算这一组的中心点
                        valid_count = len(best_group)  # “真正有效的聚类成员数量”‼ ← 用这个比较
                        cluster_info.append((qv, best_group, center_qv, valid_count))

            # 是否有词条形成聚类
            if not cluster_info and len(other_only) >= 5:
                merged_groups = group_coordinates(other_only, threshold_km=20.0)
                if merged_groups:
                    merged_groups_sorted = sorted(merged_groups, key=lambda g: -len(g))
                    best_merged_group = merged_groups_sorted[0]

                    if len(best_merged_group) >= 5 and has_real_cluster_single_query(best_merged_group, 20.0):
                        merged_count = len(best_merged_group)
                        avg_lat = sum(c[0] for c in best_merged_group) / merged_count
                        avg_lng = sum(c[1] for c in best_merged_group) / merged_count
                        merged_center = (avg_lat, avg_lng)
                        merged_qv = other_queries[0] if other_queries else "__merged_all__"
                        cluster_info.append((merged_qv, best_merged_group, merged_center, merged_count))
                        print(f"  [Merged Cluster] use all other_queries cluster, size={merged_count}")

            has_cluster_other = len(cluster_info) > 0

            # 🔍 选择最终词条：
            # 1. 有效聚类成员数量最多的
            # 2. 若一样多 → 在 other_queries 中靠前的词条优先
            chosen_qv = None
            chosen_center = None

            if has_cluster_other:
                cluster_info.sort(
                    key=lambda x: (-x[3], other_queries.index(x[0]))  # ← 用 valid_count 排序‼
                )
                chosen_qv, valid_coords, chosen_center, valid_count = cluster_info[0]
                print(f"  🔍 最终使用聚类字段: '{chosen_qv}' (有效聚类成员数={valid_count})")

            # 🧠 position vs other 决策
            if pos_ll and not has_cluster_other:
                final_lat, final_lng = pos_ll
                src = "position_preferred_no_cluster"

            elif has_cluster_other:
                final_lat, final_lng = chosen_center  # 只用该词条聚类后的中心点
                src = f"cluster_from_query: {chosen_qv}"

            else:
                # 🚨 position 无结果 & other 无聚类
                # 👉 Fallback：使用第一个 other 里有返回经纬度的词条
                #    例如：虽然没有聚类，但某词条有一个 API 返回了数据 → 可以使用！
                # 注意：只要有一个词条有返回，就要用！
                fallback_coord = None
                fallback_qv = None

                for qv in other_queries:                          # 按顺序找第一个 "有返回结果" 的词条
                    coords_for_qv = [(lat, lng, api) for api, lat, lng, qv2 in other_coords if qv2 == qv]
                    if coords_for_qv:                             # 有结果
                        fallback_coord = pick_best_coordinate(coords_for_qv, api_order)  # 用已有返回点选最佳
                        fallback_qv = qv
                        break

                if fallback_coord:                               # 至少有一个字段有返回值
                    final_lat, final_lng = fallback_coord
                    src = f"fallback_from_query: {fallback_qv}"
                    print(f"  ⚠ 未聚类，但使用了 fallback 字段: '{fallback_qv}'")
                else:
                    failed += 1                                   # 所有字段都没结果 → 真的失败！
                    print("  ❌ 所有字段都没有任何返回结果 → 无法确定经纬度")
                    continue

            # 📌 日志打印
            print("  📌 position 结果数:", len(pos_only))
            print("  📌 other_queries 每个关键字结果数:", dict(query_counts))
            print(f"  📌 other 是否有聚类: {has_cluster_other}")
            if has_cluster_other:
                print("  📌 使用 query:", chosen_qv)
                print("  📌 有效聚类成员:", valid_coords)
            print(f"  === 最终经纬度 -> {final_lat:.6f}, {final_lng:.6f} ===")
            print(f"  📌 选择来源: {src}")




            # 写入 DB
            if not args.dry_run:
                cur.execute(
                    "UPDATE attractions SET lat = ?, lng = ?, geo_source = ?, geo_query = ?, geo_updated_at = ? WHERE id = ?",
                    (final_lat, final_lng, src, name or "", datetime.now().isoformat() + 'Z', rid),
                )
                updated += 1

            time.sleep(args.sleep_ms / 250.0)


                        
            # =============== 写入数据库 ===============
            print(f"  === 最终经纬度 -> {final_lat:.6f}, {final_lng:.6f} ===")
            if not args.dry_run:
                cur.execute(
                    "UPDATE attractions SET lat = ?, lng = ?, geo_source = ?, geo_query = ?, geo_updated_at = ? WHERE id = ?",
                    (final_lat, final_lng, src, name or "", datetime.now().isoformat() + 'Z', rid),
                )
                updated += 1

            time.sleep(args.sleep_ms / 250.0)

        if not args.dry_run:
            conn.commit()
        print(f"Done. updated={updated}, failed={failed}")

    except Exception as e:
        print("\n❌ 程序出错：", e)
        import traceback
        print(traceback.format_exc())
        input("\n按回车退出...")

    finally:
        conn.close()



if __name__ == "__main__":
    try:
        # 拖动 .db 自动识别逻辑（保持你原来的）
        if len(sys.argv) == 2 and sys.argv[1].lower().endswith(".db"):
            db_path = sys.argv[1]
            if not os.path.isfile(db_path):
                print(f"数据库文件不存在: {db_path}")
                input("\n按回车退出...")
                sys.exit(1)
            country = os.path.splitext(os.path.basename(db_path))[0]
            print(f"检测到拖入的数据库文件: {db_path}")
            print(f"自动设置国家名: {country}")
            sys.argv = [sys.argv[0], "--db", db_path, "--country", country]

        elif len(sys.argv) == 1:
            print("用法示例：")
            print("  拖动数据库文件到此程序上自动执行")
            print("  或在命令行中手动运行：")
            print("  geocode_local.exe --db path/to/japan.db --country japan")
            input("\n按回车退出...")
            sys.exit(0)

        main()

    except Exception as e:
        print("\n❌ 程序出错：", e)
        import traceback
        print(traceback.format_exc())
        input("\n按回车退出...")

    finally:
        input("\n任务完成，按回车退出...")  # <--- ✨ 添加这行！
