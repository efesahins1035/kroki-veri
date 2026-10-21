# Kroki harita verisi

Kroki uygulamasının çevrimdışı harita dosyaları. Türkiye OpenStreetMap verisinden (Geofabrik) üretilir,
GitHub Pages'te yayınlanır. GitHub Actions her ayın 2'sinde kendiliğinden yeniden üretir.

- `build_offline.mjs`: .pbf dosyasından 0,25°'lik karolar (yollar, yer adları, önemli yapılar, trafik işaretleri)
- `build_provinces.py`: 81 il sınırı, il başına karo listesi ve Türkiye geneli yer adı arama dizini
- `provinces_raw.json`: il sınırları (Nominatim'den bir kez alındı; yeniden sorgulanmaz)
- `site/`: açılış sayfası ve gizlilik politikası

Elle çalıştırma:

    node --max-old-space-size=6000 build_offline.mjs turkey-latest.osm.pbf out
    python build_provinces.py out

Lisans: Harita verisi © OpenStreetMap katkıcıları, ODbL 1.0. Bu depodaki türetilmiş veri de ODbL ile sunulur.
