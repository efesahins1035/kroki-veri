// Türkiye OSM .pbf dosyasından çevrimdışı kroki verisi üretir.
// Çıktı: tools/out/offline/ altında 0.25° karolar (gzip JSON) + index.json
// Kullanım: node --max-old-space-size=6000 tools/build_offline.mjs tools/data/turkey-latest.osm.pbf
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC = process.argv[2] || 'tools/data/turkey-latest.osm.pbf';
const OUT = process.argv[3] || 'tools/out/offline';
const TS = 0.25; // karo boyu (derece)

const ROAD = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'track', 'road', 'pedestrian', 'busway']);
const AMEN = /^(fuel|parking|school|hospital|place_of_worship|marketplace)$/;
const LEIS = /^(park|pitch|stadium)$/;
const PLACE = /^(city|town|village|hamlet|suburb|neighbourhood|quarter|isolated_dwelling)$/;
const WAY_KEEP = ['highway', 'lanes', 'oneway', 'junction', 'name', 'ref', 'area', 'railway', 'waterway', 'building', 'amenity', 'leisure'];

// ---------------- minimal protobuf okuyucu ----------------
class R {
  constructor(buf, s = 0, e = buf.length) { this.b = buf; this.p = s; this.e = e; }
  eof() { return this.p >= this.e; }
  vint() {
    const b = this.b;
    let c = b[this.p++];
    if (c < 0x80) return c;
    let x = c & 0x7f, mul = 128;
    do { c = b[this.p++]; x += (c & 0x7f) * mul; mul *= 128; } while (c >= 0x80);
    return x;
  }
  svint() { const n = this.vint(); return n % 2 ? -(n + 1) / 2 : n / 2; }
  key() { const k = this.vint(); return [Math.floor(k / 8), k & 7]; }
  bytes() { const l = this.vint(); const s = this.p; this.p += l; return [s, this.p]; }
  skip(t) { if (t === 0) this.vint(); else if (t === 2) { const l = this.vint(); this.p += l; } else if (t === 1) this.p += 8; else if (t === 5) this.p += 4; else throw new Error('wt ' + t); }
}
const packed = (buf, [s, e], signed) => { const r = new R(buf, s, e), out = []; while (!r.eof()) out.push(signed ? r.svint() : r.vint()); return out; };

function* blobs(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  let pos = 0;
  const lenBuf = Buffer.alloc(4);
  while (pos < size) {
    fs.readSync(fd, lenBuf, 0, 4, pos); pos += 4;
    const hl = lenBuf.readUInt32BE(0);
    const hb = Buffer.alloc(hl); fs.readSync(fd, hb, 0, hl, pos); pos += hl;
    let type = '', dsize = 0;
    const r = new R(hb);
    while (!r.eof()) { const [f, t] = r.key(); if (f === 1) { const [s, e] = r.bytes(); type = hb.toString('utf8', s, e); } else if (f === 3) dsize = r.vint(); else r.skip(t); }
    const bb = Buffer.alloc(dsize); fs.readSync(fd, bb, 0, dsize, pos); pos += dsize;
    if (type !== 'OSMData') continue;
    const br = new R(bb);
    let data = null;
    while (!br.eof()) { const [f, t] = br.key(); if (f === 1) { const [s, e] = br.bytes(); data = bb.subarray(s, e); } else if (f === 3) { const [s, e] = br.bytes(); data = zlib.inflateSync(bb.subarray(s, e)); } else br.skip(t); }
    yield data;
  }
  fs.closeSync(fd);
}

// PrimitiveBlock'u çözer; cb.node(id,lat,lon,tags) / cb.way(id,tags,refs)
function parseBlock(buf, cb) {
  const r = new R(buf);
  let strings = [], groups = [], gran = 100, latOff = 0, lonOff = 0;
  while (!r.eof()) {
    const [f, t] = r.key();
    if (f === 1) { const [s, e] = r.bytes(); const sr = new R(buf, s, e); while (!sr.eof()) { const [ff, tt] = sr.key(); if (ff === 1) { const [a, b] = sr.bytes(); strings.push(buf.toString('utf8', a, b)); } else sr.skip(tt); } }
    else if (f === 2) groups.push(r.bytes());
    else if (f === 17) gran = r.vint();
    else if (f === 19) latOff = r.vint();
    else if (f === 20) lonOff = r.vint();
    else r.skip(t);
  }
  for (const [gs, ge] of groups) {
    const g = new R(buf, gs, ge);
    while (!g.eof()) {
      const [f, t] = g.key();
      if (f === 2 && cb.node) {
        const [ds, de] = g.bytes(), d = new R(buf, ds, de);
        let ids, lats, lons, kv = null;
        while (!d.eof()) {
          const [ff, tt] = d.key();
          if (ff === 1) ids = packed(buf, d.bytes(), true);
          else if (ff === 8) lats = packed(buf, d.bytes(), true);
          else if (ff === 9) lons = packed(buf, d.bytes(), true);
          else if (ff === 10) kv = packed(buf, d.bytes(), false);
          else d.skip(tt);
        }
        let id = 0, la = 0, lo = 0, k = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]; la += lats[i]; lo += lons[i];
          let tags = null;
          if (kv) { while (kv[k] !== 0 && k < kv.length) { (tags ||= {})[strings[kv[k]]] = strings[kv[k + 1]]; k += 2; } k++; }
          cb.node(id, (latOff + gran * la) * 1e-9, (lonOff + gran * lo) * 1e-9, tags);
        }
      } else if (f === 3 && cb.way) {
        const [ws, we] = g.bytes(), w = new R(buf, ws, we);
        let id = 0, keys = [], vals = [], refs = [];
        while (!w.eof()) {
          const [ff, tt] = w.key();
          if (ff === 1) id = w.vint();
          else if (ff === 2) keys = packed(buf, w.bytes(), false);
          else if (ff === 3) vals = packed(buf, w.bytes(), false);
          else if (ff === 8) refs = packed(buf, w.bytes(), true);
          else w.skip(tt);
        }
        const tags = {};
        for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
        let acc = 0;
        for (let i = 0; i < refs.length; i++) { acc += refs[i]; refs[i] = acc; }
        cb.way(id, tags, refs);
      } else g.skip(t);
    }
  }
}

function wanted(t) {
  if (t.highway && ROAD.has(t.highway) && t.area !== 'yes') return true;
  if (/^(rail|tram|light_rail)$/.test(t.railway)) return true;
  if (/^(river|canal|stream)$/.test(t.waterway)) return true;
  if (t.building && t.name) return true;
  if (AMEN.test(t.amenity) || LEIS.test(t.leisure)) return true;
  return false;
}

// ---------------- 1. geçiş: yollar ----------------
const t0 = Date.now();
const log = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const ways = [];
let refCount = 0;
let refBuf = new Float64Array(1 << 24);
for (const blk of blobs(SRC)) parseBlock(blk, {
  way(id, tags, refs) {
    if (!wanted(tags)) return;
    const t = {};
    for (const k of WAY_KEEP) if (tags[k] !== undefined) t[k] = k === 'building' ? 'yes' : tags[k];
    ways.push({ id, t, refs });
    if (refCount + refs.length > refBuf.length) { const nb = new Float64Array(refBuf.length * 2); nb.set(refBuf); refBuf = nb; }
    refBuf.set(refs, refCount); refCount += refs.length;
  },
});
log(`yollar: ${ways.length}, düğüm referansı: ${refCount}`);
let need = refBuf.subarray(0, refCount).sort();
let u = 0;
for (let i = 0; i < need.length; i++) if (i === 0 || need[i] !== need[i - 1]) need[u++] = need[i];
need = need.slice(0, u); refBuf = null;
log(`gerekli düğüm: ${need.length}`);

// ---------------- 2. geçiş: düğüm konumları + etiketli noktalar ----------------
const lat = new Int32Array(need.length), lon = new Int32Array(need.length);
const find = id => { let lo = 0, hi = need.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (need[m] < id) lo = m + 1; else if (need[m] > id) hi = m - 1; else return m; } return -1; };
const points = [];
for (const blk of blobs(SRC)) parseBlock(blk, {
  node(id, la, lo, tags) {
    const i = find(id);
    if (i >= 0) { lat[i] = Math.round(la * 1e5); lon[i] = Math.round(lo * 1e5); }
    if (!tags) return;
    const hw = tags.highway;
    if (/^(traffic_signals|crossing|stop|give_way)$/.test(hw) && !(hw === 'crossing' && /^(no|unmarked)$/.test(tags.crossing))) points.push({ i: id, t: { highway: hw }, c: [Math.round(la * 1e5), Math.round(lo * 1e5)] });
    else if (PLACE.test(tags.place) && tags.name) points.push({ i: id, t: { place: tags.place, name: tags.name }, c: [Math.round(la * 1e5), Math.round(lo * 1e5)] });
  },
});
log(`nokta: ${points.length}`);

// ---------------- karolara dağıt ----------------
const tiles = new Map();
const tileOf = (la, lo) => `${Math.floor(lo / 1e5 / TS)}_${Math.floor(la / 1e5 / TS)}`;
const put = (key, kind, obj) => { let t = tiles.get(key); if (!t) tiles.set(key, t = { w: [], n: [] }); t[kind].push(obj); };
for (const w of ways) {
  const c = [];
  let la0 = 0, lo0 = 0, minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity, ok = true;
  for (const ref of w.refs) {
    const i = find(ref);
    if (i < 0) { ok = false; break; }
    const la = lat[i], lo = lon[i];
    c.push(la - la0, lo - lo0); la0 = la; lo0 = lo;
    minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la); minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo);
  }
  if (!ok || c.length < 4) continue;
  const obj = { i: w.id, t: w.t, c };
  const x0 = Math.floor(minLo / 1e5 / TS), x1 = Math.floor(maxLo / 1e5 / TS), y0 = Math.floor(minLa / 1e5 / TS), y1 = Math.floor(maxLa / 1e5 / TS);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) put(`${x}_${y}`, 'w', obj);
}
for (const p of points) put(tileOf(p.c[0], p.c[1]), 'n', p);
log(`karo: ${tiles.size}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'tiles'), { recursive: true });
const index = { v: 1, date: new Date().toISOString().slice(0, 10), ts: TS, tiles: {} };
let total = 0;
for (const [k, t] of tiles) {
  const gz = zlib.gzipSync(JSON.stringify(t), { level: 9 });
  fs.writeFileSync(path.join(OUT, 'tiles', k + '.json.gz'), gz);
  index.tiles[k] = gz.length; total += gz.length;
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
// Arama dizini için ham yer adları (il bilgisi build_provinces.py'de eklenir)
fs.writeFileSync(path.join(OUT, 'places_raw.json'), JSON.stringify(points.filter(p => p.t.place).map(p => [p.t.name, p.c[0], p.c[1], p.t.place])));
log(`bitti: ${(total / 1048576).toFixed(1)} MB toplam`);
