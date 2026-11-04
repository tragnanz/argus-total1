from analysis import river_obs


def test_dataset_presente():
    s = river_obs.stations()
    assert len(s) > 20000 and all(len(x["mm"]) == 12 for x in s[:50])
    assert not any("sc" in x for x in s)


def test_stazioni_utilizzabili():
    ok = [x for x in river_obs.stations() if river_obs.usable(x)]
    assert len(ok) > 20000
    assert all(x["n"] >= 10 or x["src"] == "kzh" for x in ok)
    assert any(x["src"] == "kzh" and x["river"] == "Ili" for x in ok)
