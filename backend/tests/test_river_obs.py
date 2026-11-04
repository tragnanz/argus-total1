from analysis import river_obs


def _cell(lat, lon, mean):
    return {"lat": lat, "lon": lon, "mean": mean, "month_mean": [mean] * 12}


def test_correzione_con_la_stazione_dello_stesso_fiume(monkeypatch):
    st = [
        {"src": "unh", "id": "A", "river": "Grande", "station": "Valle", "cc": "XX", "lat": 10.0, "lon": 10.5,
         "area": 1, "mean": 250.0, "mm": [250.0] * 12, "yrs": [1950, 1980], "n": 31},
        {"src": "unh", "id": "B", "river": "Affluente", "station": "Ponte", "cc": "XX", "lat": 10.0, "lon": 10.1,
         "area": 1, "mean": 100.0, "mm": [100.0] * 12, "yrs": [1950, 1980], "n": 31},
    ]
    monkeypatch.setattr(river_obs, "stations", lambda: st)
    sims = {"A": [_cell(10, 10.5, 1000.0), _cell(10, 10.55, 1.0)], "B": [_cell(10, 10.1, 120.0)]}

    def fake(lat, lon, n):
        return {"cells": sims["A" if lon > 10.3 else "B"]}

    c = river_obs.correction(10.0, 10.0, {"mean": 900.0}, fake)
    assert c["station"]["id"] == "A"           # l'affluente (120 contro 900) non è lo stesso fiume
    assert abs(c["f_year"] - 0.25) < 1e-6
    assert all(abs(f - 0.25) < 1e-6 for f in c["f_month"])


def test_nessuna_stazione_compatibile(monkeypatch):
    monkeypatch.setattr(river_obs, "stations", lambda: [])
    assert river_obs.correction(10.0, 10.0, {"mean": 900.0}, lambda *a: {"cells": []}) is None


def test_dataset_presente():
    s = river_obs.stations()
    assert len(s) > 3000 and all(len(x["mm"]) == 12 for x in s[:50])
