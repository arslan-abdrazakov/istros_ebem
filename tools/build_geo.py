#!/usr/bin/env python3
"""
Сборка картографических данных для сайта -> content/geo.js

Источники:
  * Natural Earth 1:10m (общественное достояние): границы субъектов РФ,
    озёра, городские территории, Иртыш и Ишим за пределами выборки OSM.
    Скачиваются из https://github.com/nvkelso/natural-earth-vector
  * OpenStreetMap (© участники OpenStreetMap, ODbL): осевые линии рек
    Тура, Тобол, Иртыш (у Тобольска), Исеть, Пышма, Тавда, Вагай, Тюменка.
    Лежат в tools/data/rivers_osm.txt (упрощены алгоритмом Дугласа — Пейкера,
    координаты в 1e-4 градуса, дельта-кодирование).

Запуск (нужен Python 3 и пакет shapely):
    pip install shapely
    python3 tools/build_geo.py --ne-dir путь/к/папке/с/geojson

Результат — content/geo.js. Пересобирать нужно только при изменении карты.
"""
import argparse, json, os, sys, urllib.request
from shapely.geometry import shape, box, mapping, LineString, MultiLineString, Polygon, MultiPolygon
from shapely.ops import unary_union

EXTENT = (63.6, 55.6, 70.6, 59.5)   # lon_min, lat_min, lon_max, lat_max
NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
NE_FILES = ["ne_10m_admin_1_states_provinces", "ne_10m_lakes",
            "ne_10m_rivers_lake_centerlines", "ne_10m_urban_areas"]

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load_ne(ne_dir, name):
    path = os.path.join(ne_dir, name + ".geojson")
    if not os.path.exists(path):
        print("downloading", name, file=sys.stderr)
        urllib.request.urlretrieve(NE_BASE + name + ".geojson", path)
    with open(path, encoding="utf8") as f:
        return json.load(f)


def rnd(geom, nd=4):
    """Округлить координаты, вернуть список колец/линий."""
    def r(seq):
        return [[round(x, nd), round(y, nd)] for x, y in seq]
    if isinstance(geom, Polygon):
        return [r(geom.exterior.coords)] + [r(i.coords) for i in geom.interiors]
    if isinstance(geom, LineString):
        return r(geom.coords)
    raise TypeError(geom.geom_type)


def polys(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def lines(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, LineString)]


def chaikin(coords, iterations=2):
    """Сглаживание углов у сильно упрощённых рек (метод Чайкина)."""
    pts = list(coords)
    for _ in range(iterations):
        out = [pts[0]]
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
            out.append((0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1))
            out.append((0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1))
        out.append(pts[-1])
        pts = out
    return pts


SMOOTH = {"Пышма", "Исеть", "Тавда", "Вагай"}


def decode_osm_rivers(path):
    out = {}
    with open(path, encoding="utf8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            key, data = line.split("|")
            name = key.split("#")[0]
            a = list(map(int, data.split(",")))
            pts, x, y = [], 0, 0
            for i in range(0, len(a), 2):
                x += a[i]; y += a[i + 1]
                pts.append((x / 1e4, y / 1e4))
            if name in SMOOTH:
                pts = chaikin(pts)
            out.setdefault(name, []).append(LineString(pts))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ne-dir", default=os.path.join(HERE, "data", "ne"))
    ap.add_argument("--out", default=os.path.join(ROOT, "content", "geo.js"))
    args = ap.parse_args()
    os.makedirs(args.ne_dir, exist_ok=True)
    clip = box(*EXTENT)

    # --- регионы ---
    adm = load_ne(args.ne_dir, "ne_10m_admin_1_states_provinces")
    regions = []
    for f in adm["features"]:
        p = f["properties"]
        if p.get("admin") != "Russia":
            continue
        g = shape(f["geometry"])
        if not g.intersects(clip):
            continue
        g = g.intersection(clip).simplify(0.006, preserve_topology=True)
        regions.append({
            "name": p.get("name_ru") or p.get("name"),
            "tyumen": p.get("name") == "Tyumen'",
            "rings": [rnd(pg) for pg in polys(g)],
        })

    # --- озёра ---
    lk = load_ne(args.ne_dir, "ne_10m_lakes")
    lakes = []
    for f in lk["features"]:
        g = shape(f["geometry"])
        if g.intersects(clip):
            g = g.intersection(clip).simplify(0.002, preserve_topology=True)
            for pg in polys(g):
                if pg.area > 0.00003:
                    lakes.append({"name": f["properties"].get("name_ru") or "", "rings": rnd(pg)})

    # Андреевское озеро и соседние озёра под Тюменью — из OpenStreetMap
    with open(os.path.join(HERE, "data", "lakes_osm.txt"), encoding="utf8") as f:
        for line in f:
            if not line.strip():
                continue
            name, data = line.strip().split("|")
            a = list(map(int, data.split(",")))
            pts, x, y = [], 0, 0
            for i in range(0, len(a), 2):
                x += a[i]; y += a[i + 1]
                pts.append([x / 1e4, y / 1e4])
            if pts[0] != pts[-1]:
                pts.append(pts[0])
            lakes.append({"name": name, "rings": [pts]})

    # --- города (пятна городской застройки) ---
    ur = load_ne(args.ne_dir, "ne_10m_urban_areas")
    cities = {"Тюмень": (65.54, 57.15), "Тобольск": (68.25, 58.20), "Ялуторовск": (66.30, 56.65)}
    urban = []
    for f in ur["features"]:
        g = shape(f["geometry"])
        for name, (lon, lat) in cities.items():
            if g.distance(shape({"type": "Point", "coordinates": [lon, lat]})) < 0.08:
                g2 = g.simplify(0.003, preserve_topology=True)
                for pg in polys(g2):
                    urban.append({"name": name, "rings": rnd(pg)})

    # --- реки ---
    rivers = {}
    osm = decode_osm_rivers(os.path.join(HERE, "data", "rivers_osm.txt"))
    for name, ls in osm.items():
        rivers[name] = [rnd(part) for l in ls for part in lines(l.intersection(clip))]
    # Иртыш и Ишим вне выборки OSM — из Natural Earth
    osm_irtysh_box = box(67.4, 57.6, 69.21, 59.05)
    rv = load_ne(args.ne_dir, "ne_10m_rivers_lake_centerlines")
    for f in rv["features"]:
        nm = f["properties"].get("name")
        if nm not in ("Irtysh", "Ishim"):
            continue
        g = shape(f["geometry"]).intersection(clip)
        if nm == "Irtysh":
            g = g.difference(osm_irtysh_box)
        rus = "Иртыш" if nm == "Irtysh" else "Ишим"
        for l in lines(g.simplify(0.003)):
            rivers.setdefault(rus, []).append(rnd(l))

    geo = {
        "extent": EXTENT,
        "attribution": "Natural Earth; © участники OpenStreetMap (ODbL)",
        "regions": regions,
        "lakes": lakes,
        "urban": urban,
        "rivers": rivers,
    }
    js = ("/* Автоматически собрано tools/build_geo.py — не редактируйте вручную.\n"
          "   Источники: Natural Earth (общественное достояние); © участники OpenStreetMap (ODbL). */\n"
          "window.JOURNEY_GEO = " + json.dumps(geo, ensure_ascii=False, separators=(",", ":")) + ";\n")
    with open(args.out, "w", encoding="utf8") as f:
        f.write(js)
    print("written", args.out, len(js) // 1024, "KB;",
          "regions", len(regions), "lakes", len(lakes), "urban", len(urban),
          "rivers", {k: len(v) for k, v in rivers.items()})


if __name__ == "__main__":
    main()
