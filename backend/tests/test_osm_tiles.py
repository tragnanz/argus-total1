"""Decodificatore dei tasselli vettoriali (analysis/osm_tiles.py) su un tassello costruito a mano."""
from analysis import osm_tiles as O


def _vint(v: int) -> bytes:
    out = b""
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def _fld(n: int, payload: bytes) -> bytes:
    return _vint((n << 3) | 2) + _vint(len(payload)) + payload


def _zz(v: int) -> int:
    return (v << 1) ^ (v >> 31)


def test_decodifica_linea():
    # linea (10,20) → (110,20) → (110,220), classe river, nome "Gorgol"
    geom = [(1 << 3) | 1, _zz(10), _zz(20), (2 << 3) | 2, _zz(100), _zz(0), _zz(0), _zz(200)]
    feat = _fld(2, b"".join(_vint(x) for x in [0, 0, 1, 1])) + _vint((3 << 3) | 0) + _vint(2) + _fld(4, b"".join(_vint(x) for x in geom))
    layer = (_fld(1, b"waterway") + _fld(2, feat) + _fld(3, b"class") + _fld(3, b"name")
             + _fld(4, _fld(1, b"river")) + _fld(4, _fld(1, "Gorgol".encode())) + _vint((5 << 3) | 0) + _vint(4096))
    tile = _fld(3, layer)
    extent, feats = O.decode_layer(tile, "waterway")
    assert extent == 4096 and len(feats) == 1
    assert feats[0]["props"] == {"class": "river", "name": "Gorgol"}
    assert feats[0]["lines"] == [[(10, 20), (110, 20), (110, 220)]]
    assert O.decode_layer(tile, "transportation") == (4096, [])


def test_coordinate_tasselli():
    x, y = O._tile_xy(-12.77, 16.13, 14)
    lon, lat = O._lonlat(x, y, 14)
    assert abs(lon + 12.77) < 1e-9 and abs(lat - 16.13) < 1e-9


def test_ritaglio_e_ricucitura():
    # linea che esce dal tassello e rientra: due pezzi ritagliati sul bordo
    parts = O._clip([(-10.0, 5.0), (5.0, 5.0), (15.0, 5.0), (15.0, 8.0), (5.0, 8.0)], 0.0, 10.0)
    assert parts == [[(0.0, 5.0), (5.0, 5.0), (10.0, 5.0)], [(10.0, 8.0), (5.0, 8.0)]]
    assert O._clip([(20.0, 20.0), (30.0, 30.0)], 0.0, 10.0) == []
    # tre pezzi dello stesso fiume, uno al contrario: una linea sola
    m = O._merge([[(0, 0), (1, 0)], [(2, 0), (1, 0)], [(2, 0), (3, 1)]])
    assert len(m) == 1 and m[0][0] in ((0, 0), (3, 1)) and len(m[0]) == 4
    # confluenza (tre linee nello stesso punto): restano tre
    assert len(O._merge([[(0, 0), (1, 0)], [(1, 0), (2, 0)], [(1, 0), (1, 1)]])) == 3


def test_senza_shapely(monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "shapely", None)
    monkeypatch.setitem(sys.modules, "shapely.geometry", None)
    monkeypatch.setitem(sys.modules, "shapely.ops", None)
    assert O._merge(O._clip([(0.0, 1.0), (5.0, 1.0)], 0.0, 4.0)) == [[(0.0, 1.0), (4.0, 1.0)]]


def test_clip_to_polygon_esce_e_rientra():
    from analysis.osm_tiles import clip_to_polygon, courses_in_polygon
    sq = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
    # linea che entra, esce e rientra: due pezzi, estremi sul bordo
    pcs = clip_to_polygon([[-0.5, 0.5], [0.5, 0.5], [0.5, 1.5], [0.8, 1.5], [0.8, 0.2]], sq)
    assert len(pcs) == 2
    assert pcs[0][0] == [0.0, 0.5] and abs(pcs[0][-1][1] - 1.0) < 1e-12
    assert abs(pcs[1][0][1] - 1.0) < 1e-12 and abs(pcs[1][-1][0] - 0.8) < 1e-12 and abs(pcs[1][-1][1] - 0.2) < 1e-12
    # tutta fuori
    assert clip_to_polygon([[2, 2], [3, 3]], sq) == []
    # corsi OSM già scaricati: tipo, nome e lunghezza; i tratti sotto 50 m restano fuori
    geom = {"type": "Polygon", "coordinates": [[[10.0, 45.0], [10.01, 45.0], [10.01, 45.01], [10.0, 45.01], [10.0, 45.0]]]}
    osm = [{"waterway": "canal", "name": "C", "coords": [[9.99, 45.005], [10.02, 45.005]]},
           {"waterway": "ditch", "coords": [[10.005, 45.0099], [10.005, 45.0105]]},
           {"waterway": "weir", "coords": [[10.0, 45.0], [10.01, 45.01]]}]
    r = courses_in_polygon(geom, osm)
    assert r["n_osm"] == 1 and r["features"][0]["kind"] == "canal" and r["features"][0]["name"] == "C"
    assert abs(r["features"][0]["length_m"] - 788) < 5
