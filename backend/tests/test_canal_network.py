"""Rete dei canali principali: segue il terreno e passa fuori dai pivot."""
import numpy as np

from analysis.route import canal_network


class Ridge:
    """Pendio che scende verso est (1 m ogni 200 m) con una dorsale alta 6 m al centro, orientata nord-sud
    ma interrotta a sud: il canale deve aggirarla invece di attraversarla."""
    def fetch_dem(self, bbox, epsg, wp, hp, dem_instance=None):
        x0, y0, x1, y1 = bbox
        xs = np.linspace(x0, x1, wp); ys = np.linspace(y1, y0, hp)
        X, Y = np.meshgrid(xs, ys)
        z = 50.0 - (X - x0) / 200.0
        mid = (x0 + x1) / 2
        ridge = (np.abs(X - mid) < 120) & (Y > y0 + (y1 - y0) * 0.35)
        return np.where(ridge, z + 6.0, z)


def test_rami_aggirano_dorsale_e_pivot():
    head = [10.000, 45.010]
    st = [[10.030, 45.020], [10.030, 45.005]]
    circ = [[10.015, 45.000, 300.0]]
    r = canal_network(Ridge(), head, st, circles=circ, target_permille=0.3)
    assert not r["unreached"] and len(r["branches"]) == 2
    for b in r["branches"]:
        zs = [z for _, z in b["profile"]]
        # niente risalite sulla dorsale: la quota lungo il ramo non supera quella dell'attacco di oltre 1,5 m
        assert max(zs) - zs[0] < 1.5
        assert b["in_circles"] < 0.2
