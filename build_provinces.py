"""81 ilin sınırını Nominatim'den alır, sadeleştirir ve her ilin karolarını hesaplar.
Çıktı: tools/out/offline/provinces.json  (karolar build_offline.mjs ile üretildikten sonra çalıştırın)
Nominatim cevapları tools/provinces_raw.json içinde saklanır; tekrar çalıştırınca yeniden sorgulanmaz.
"""
import gzip, json, math, os, sys, time, urllib.parse, urllib.request
from shapely.geometry import shape, box, Point
from shapely.prepared import prep
from shapely.strtree import STRtree

ILLER = ["Adana", "Adıyaman", "Afyonkarahisar", "Ağrı", "Amasya", "Ankara", "Antalya", "Artvin", "Aydın", "Balıkesir",
         "Bilecik", "Bingöl", "Bitlis", "Bolu", "Burdur", "Bursa", "Çanakkale", "Çankırı", "Çorum", "Denizli",
         "Diyarbakır", "Edirne", "Elazığ", "Erzincan", "Erzurum", "Eskişehir", "Gaziantep", "Giresun", "Gümüşhane", "Hakkari",
         "Hatay", "Isparta", "Mersin", "İstanbul", "İzmir", "Kars", "Kastamonu", "Kayseri", "Kırklareli", "Kırşehir",
         "Kocaeli", "Konya", "Kütahya", "Malatya", "Manisa", "Kahramanmaraş", "Mardin", "Muğla", "Muş", "Nevşehir",
         "Niğde", "Ordu", "Rize", "Sakarya", "Samsun", "Siirt", "Sinop", "Sivas", "Tekirdağ", "Tokat",
         "Trabzon", "Tunceli", "Şanlıurfa", "Uşak", "Van", "Yozgat", "Zonguldak", "Aksaray", "Bayburt", "Karaman",
         "Kırıkkale", "Batman", "Şırnak", "Bartın", "Ardahan", "Iğdır", "Yalova", "Karabük", "Kilis", "Osmaniye", "Düzce"]

OUT = sys.argv[1] if len(sys.argv) > 1 else "tools/out/offline"
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "provinces_raw.json")
UA = {"User-Agent": "KrokiApp/0.2 (kaza krokisi uygulamasi; il sinirlari bir kerelik)"}


def fetch(il):
    q = urllib.parse.urlencode({"q": il, "countrycodes": "tr", "featureType": "state", "format": "json",
                                "polygon_geojson": 1, "polygon_threshold": 0.003, "limit": 1, "accept-language": "tr"})
    req = urllib.request.Request("https://nominatim.openstreetmap.org/search?" + q, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        js = json.load(r)
    return js[0] if js else None


raw = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}
for il in ILLER:
    if il in raw:
        continue
    res = fetch(il)
    raw[il] = res
    print(il, res and res.get("addresstype"), res and res.get("geojson", {}).get("type"))
    json.dump(raw, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)
    time.sleep(1.2)

index = json.load(open(os.path.join(OUT, "index.json"), encoding="utf-8"))
TS = index["ts"]
out = []
for il in ILLER:
    r = raw[il]
    g = shape(r["geojson"])
    if g.geom_type not in ("Polygon", "MultiPolygon"):
        print("UYARI: poligon yok", il, g.geom_type)
        continue
    simple = g.simplify(0.01, preserve_topology=True)
    w, s, e, n = g.bounds
    tiles, size = [], 0
    for x in range(math.floor(w / TS), math.floor(e / TS) + 1):
        for y in range(math.floor(s / TS), math.floor(n / TS) + 1):
            k = f"{x}_{y}"
            if k in index["tiles"] and g.intersects(box(x * TS, y * TS, (x + 1) * TS, (y + 1) * TS)):
                tiles.append(k)
                size += index["tiles"][k]
    polys = [simple] if simple.geom_type == "Polygon" else list(simple.geoms)
    out.append({
        "name": il,
        "bbox": [round(s, 4), round(w, 4), round(n, 4), round(e, 4)],
        "poly": [[[round(c, 3) for c in pt] for pt in p.exterior.coords] for p in polys],
        "tiles": tiles,
        "size": size,
    })
    print(f"{il:16s} {len(tiles):3d} karo  {size / 1048576:5.1f} MB")

# Türkiye geneli yer adı arama dizini: [ad, lat*1e5, lon*1e5, tür, il sırası]
raw_places = os.path.join(OUT, "places_raw.json")
if os.path.exists(raw_places):
    geoms = [shape(raw[p["name"]]["geojson"]) for p in out]
    tree = STRtree(geoms)
    preps = [prep(g) for g in geoms]
    rows = []
    for name, la, lo, kind in json.load(open(raw_places, encoding="utf-8")):
        pt = Point(lo / 1e5, la / 1e5)
        il = -1
        for i in tree.query(pt):
            if preps[i].contains(pt):
                il = int(i)
                break
        rows.append([name, la, lo, kind, il])
    blob = json.dumps({"iller": [p["name"] for p in out], "places": rows}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    open(os.path.join(OUT, "places.json.gz"), "wb").write(gzip.compress(blob, 9))
    os.remove(raw_places)
    print("yer adı:", len(rows), "dizin:", round(os.path.getsize(os.path.join(OUT, "places.json.gz")) / 1048576, 1), "MB")

json.dump({"v": 1, "date": index["date"], "provinces": out}, open(os.path.join(OUT, "provinces.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("toplam il:", len(out))
