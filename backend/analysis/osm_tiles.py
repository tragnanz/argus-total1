"""Corsi d'acqua di OpenStreetMap dai tasselli vettoriali di OpenFreeMap (schema OpenMapTiles).

Overpass, il servizio di interrogazione di OSM, è spesso sovraccarico («at capacity») e il
browser lo vede fallire; i tasselli vettoriali di OpenFreeMap stanno su CDN, sono aggiornati
ogni poche settimane e hanno lo strato `waterway` con classe (river, stream, canal, drain,
ditch), nome e intermittenza. Li legge il backend: tasselli a z14 sul riquadro, ritaglio
sul bordo di ogni tassello, ricucitura delle linee spezzate fra tasselli.

Dati © OpenStreetMap contributors (ODbL); tasselli OpenFreeMap / OpenMapTiles.
Decodificatore Mapbox Vector Tile (protobuf), ritaglio e ricucitura qui sotto: nessuna
dipendenza oltre a requests (shapely non è installato in produzione).
"""
from __future__ import annotations

import math
import time
from concurrent.futures import ThreadPoolExecutor

import requests

TILEJSON = "https://tiles.openfreemap.org/planet"
UA = "ArgusTotal/0.6 (+https://argus-total.nabugroup.it)"
Z = 14
MAX_TILES = 400
CLASSES = {"river", "stream", "canal", "drain", "ditch"}
_tpl: dict = {"url": None, "t": 0.0}


# ------------------------------------------------------------------ protobuf minimo

def _varint(b: bytes, i: int) -> tuple[int, int]:
    v = s = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7F) << s
        if c < 0x80:
            return v, i
        s += 7


def _fields(b: bytes):
    """(numero campo, tipo, valore) di un messaggio protobuf."""
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            ln, i = _varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif t == 1:
            v = b[i:i + 8]
            i += 8
        elif t == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError("protobuf: tipo di campo non gestito")
        yield f, t, v


def _packed(b: bytes) -> list[int]:
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i)
        out.append(v)
    return out


def _value(b: bytes):
    import struct
    for f, t, v in _fields(b):
        if f == 1:
            return v.decode("utf-8", "replace")
        if f == 2:
            return struct.unpack("<f", v)[0]
        if f == 3:
            return struct.unpack("<d", v)[0]
        if f in (4, 5):
            return v
        if f == 6:
            return (v >> 1) ^ -(v & 1)
        if f == 7:
            return bool(v)
    return None


def _lines(geom: list[int]) -> list[list[tuple[int, int]]]:
    """Comandi MVT (MoveTo/LineTo) → linee in coordinate del tassello."""
    out, cur = [], []
    x = y = i = 0
    while i < len(geom):
        cmd, cnt = geom[i] & 7, geom[i] >> 3
        i += 1
        if cmd == 7:
            continue
        for _ in range(cnt):
            dx, dy = geom[i], geom[i + 1]
            i += 2
            x += (dx >> 1) ^ -(dx & 1)
            y += (dy >> 1) ^ -(dy & 1)
            if cmd == 1:
                if len(cur) >= 2:
                    out.append(cur)
                cur = [(x, y)]
            else:
                cur.append((x, y))
    if len(cur) >= 2:
        out.append(cur)
    return out


def decode_layer(tile: bytes, name: str) -> tuple[int, list[dict]]:
    """Feature di uno strato: [{props, type, lines}], estensione del tassello."""
    for f, _t, lay in _fields(tile):
        if f != 3:
            continue
        lname, extent, keys, vals, feats = None, 4096, [], [], []
        for g, _u, v in _fields(lay):
            if g == 1:
                lname = v.decode()
            elif g == 3:
                keys.append(v.decode())
            elif g == 4:
                vals.append(_value(v))
            elif g == 5:
                extent = v
            elif g == 2:
                feats.append(v)
        if lname != name:
            continue
        out = []
        for fb in feats:
            tags, gtype, geom = [], 0, []
            for h, _w, v in _fields(fb):
                if h == 2:
                    tags = _packed(v)
                elif h == 3:
                    gtype = v
                elif h == 4:
                    geom = _packed(v)
            if gtype != 2:                     # solo linee
                continue
            props = {keys[tags[k]]: vals[tags[k + 1]] for k in range(0, len(tags) - 1, 2)}
            out.append({"props": props, "lines": _lines(geom)})
        return extent, out
    return 4096, []


# ------------------------------------------------------------------ tasselli

def _template() -> str:
    if _tpl["url"] and time.time() - _tpl["t"] < 6 * 3600:
        return _tpl["url"]
    r = requests.get(TILEJSON, timeout=20, headers={"User-Agent": UA})
    r.raise_for_status()
    _tpl.update(url=r.json()["tiles"][0], t=time.time())
    return _tpl["url"]


def _tile_xy(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def _lonlat(tx: float, ty: float, z: int) -> tuple[float, float]:
    n = 2 ** z
    lon = tx / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    return lon, lat


def _fetch(url: str) -> bytes | None:
    for k in range(3):
        try:
            r = requests.get(url, timeout=20, headers={"User-Agent": UA})
            if r.status_code == 404:
                return b""                         # tassello vuoto (mare, deserto)
            r.raise_for_status()
            return r.content
        except Exception:  # noqa: BLE001
            time.sleep(0.5 * (k + 1))
    return None


def _clip(line: list[tuple[float, float]], lo: float, hi: float) -> list[list[tuple[float, float]]]:
    """Ritaglio di una polilinea sul quadrato [lo, hi]² (Liang-Barsky segmento per segmento)."""
    out, cur = [], []
    for (x0, y0), (x1, y1) in zip(line[:-1], line[1:]):
        dx, dy = x1 - x0, y1 - y0
        t0, t1, ok = 0.0, 1.0, True
        for p, q in ((-dx, x0 - lo), (dx, hi - x0), (-dy, y0 - lo), (dy, hi - y0)):
            if p == 0:
                if q < 0:
                    ok = False
                    break
                continue
            r = q / p
            if p < 0:
                t0 = max(t0, r)
            else:
                t1 = min(t1, r)
            if t0 > t1:
                ok = False
                break
        if not ok:
            if len(cur) >= 2:
                out.append(cur)
            cur = []
            continue
        a = (x0 + t0 * dx, y0 + t0 * dy)
        b = (x0 + t1 * dx, y0 + t1 * dy)
        if cur and (abs(cur[-1][0] - a[0]) > 1e-9 or abs(cur[-1][1] - a[1]) > 1e-9):
            if len(cur) >= 2:
                out.append(cur)
            cur = []
        if not cur:
            cur = [a]
        cur.append(b)
        if t1 < 1.0:                                   # esce dal quadrato
            if len(cur) >= 2:
                out.append(cur)
            cur = []
    if len(cur) >= 2:
        out.append(cur)
    return out


def _merge(lines: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """Ricuce le linee che si toccano agli estremi (nodi con esattamente due linee),
    come shapely.ops.linemerge: un fiume spezzato fra tasselli torna una linea sola."""
    lines = [ln for ln in lines if len(ln) >= 2]
    deg: dict = {}
    for ln in lines:
        for e in (ln[0], ln[-1]):
            deg[e] = deg.get(e, 0) + 1
    ends: dict = {}
    for k, ln in enumerate(lines):
        ends.setdefault(ln[0], []).append(k)
        ends.setdefault(ln[-1], []).append(k)
    used = [False] * len(lines)

    def grow(chain: list, at_end: bool) -> list:
        while True:
            node = chain[-1] if at_end else chain[0]
            if deg.get(node, 0) != 2:
                return chain
            nxt = [k for k in ends.get(node, []) if not used[k]]
            if not nxt:
                return chain
            k = nxt[0]
            used[k] = True
            ln = lines[k]
            if at_end:
                chain = chain + (ln[1:] if ln[0] == node else ln[::-1][1:])
            else:
                chain = (ln[:-1] if ln[-1] == node else ln[::-1][:-1]) + chain
    out = []
    for k, ln in enumerate(lines):
        if used[k]:
            continue
        used[k] = True
        chain = grow(grow(list(ln), True), False)
        out.append(chain)
    return out


def waterways(bbox: list[float]) -> list[dict]:
    """Corsi d'acqua OSM nel riquadro [lon_min, lat_min, lon_max, lat_max]:
    [{id, waterway, name, intermittent, coords [[lon, lat], ...]}], linee ricucite fra tasselli."""
    w, s, e, n = bbox
    z = Z
    while True:
        x0, y0 = _tile_xy(w, n, z)
        x1, y1 = _tile_xy(e, s, z)
        tiles = [(x, y) for x in range(int(x0), int(x1) + 1) for y in range(int(y0), int(y1) + 1)]
        if len(tiles) <= MAX_TILES or z <= 12:
            break
        z -= 1
    tpl = _template()
    with ThreadPoolExecutor(max_workers=8) as ex:
        datas = list(ex.map(lambda t: _fetch(tpl.replace("{z}", str(z)).replace("{x}", str(t[0])).replace("{y}", str(t[1]))), tiles))
    if any(d is None for d in datas) and all(d is None for d in datas):
        raise RuntimeError("tasselli OpenFreeMap non raggiungibili")
    groups: dict[tuple, list] = {}
    for (tx, ty), data in zip(tiles, datas):
        if not data:
            continue
        extent, feats = decode_layer(data, "waterway")
        for f in feats:
            cls = f["props"].get("class")
            if cls not in CLASSES:
                continue
            key = (cls, f["props"].get("name") or f["props"].get("name:latin") or "", int(f["props"].get("intermittent") or 0))
            for ln in f["lines"]:
                for p in _clip([(float(x), float(y)) for x, y in ln], 0.0, float(extent)):   # i tasselli sbordano
                    ll = [_lonlat(tx + px / extent, ty + py / extent, z) for px, py in p]
                    # 5 decimali (~1 m): i punti sul bordo comune di due tasselli coincidono
                    # e le linee si ricuciono
                    groups.setdefault(key, []).append([(round(a, 5), round(b, 5)) for a, b in ll])
    out, k = [], 0
    for (cls, name, inter), lines in groups.items():
        for g in _merge(lines):
            k += 1
            out.append({"id": k, "waterway": cls, "name": name or None, "intermittent": "yes" if inter else None,
                        "coords": [[round(a, 6), round(b, 6)] for a, b in g]})
    return out
