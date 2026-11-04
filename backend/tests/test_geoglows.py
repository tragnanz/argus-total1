from analysis import geoglows as G


def test_indice_e_rete():
    ix = G.index()
    assert len(ix["col"]) > 1_000_000 and len(ix["pr"]) > 2_000_000
    # Nilo a Shendi: il tratto più grande entro 3 km ha un bacino di quasi 2 milioni di km²
    near = G.reaches_near(16.69, 33.43, 3.0)
    big = max(near, key=lambda r: r["area_km2"])
    assert big["area_km2"] > 1_500_000
    # Dongola (a valle) è sullo stesso fiume; il Nilo Azzurro a Khartoum no (è a monte di un altro ramo)
    dongola = max(G.reaches_near(19.17, 30.48, 8.0), key=lambda r: r["area_km2"])
    assert G.same_river(big["i"], dongola["i"])
    po = max(G.reaches_near(45.13, 10.02, 3.0), key=lambda r: r["area_km2"])
    assert not G.same_river(big["i"], po["i"])
