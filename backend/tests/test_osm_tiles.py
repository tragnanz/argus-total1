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
