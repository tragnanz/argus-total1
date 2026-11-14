"""Salti di quota: dove il terreno scende più del canale si mette un salto, mai oltre il salto massimo."""
from analysis.canal_design import design_canal


def test_salti_dove_il_terreno_scende():
    d = [i * 20.0 for i in range(201)]                     # 4 km
    z = [30.0 - 0.002 * x for x in d]                      # terreno 2‰, canale 0,3‰ → 6,8 m da recuperare
    prof = {"d": d, "z": z, "ll": [[0.0, 0.0]] * len(d)}
    r = design_canal(prof, b=1.0, y=1.0, fb=0.3, m=1.5, slope_permille=0.3, drop_max=1.0)
    assert r["n_drops"] >= 7 and all(x["h"] <= 1.0 for x in r["drops"])
    assert abs(r["drop_total_m"] - 6.8) < 1.2
    # mai pensile oltre la tolleranza: argini al livello del terreno
    assert max(b - zz for b, zz in zip(r["profile"]["bank"], r["profile"]["z"])) < 0.35


def test_nessun_salto_in_piano():
    d = [i * 20.0 for i in range(101)]
    prof = {"d": d, "z": [30.0] * len(d), "ll": [[0.0, 0.0]] * len(d)}
    r = design_canal(prof, b=1.0, y=1.0, fb=0.3, m=1.5, slope_permille=0.3)
    assert r["n_drops"] == 0 and r["cut_max_m"] > 1.3
