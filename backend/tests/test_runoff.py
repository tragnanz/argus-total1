from analysis.soil import runoff_threshold, saxton_rawls_ks, slope_factor


def test_saxton_rawls_ordine_tessiture():
    # Saxton & Rawls 2006: la Ks cala dalla sabbia all'argilla
    ks = [saxton_rawls_ks(s, c, 2.5) for s, c in [(90, 3), (65, 10), (40, 20), (30, 35), (20, 50)]]
    assert ks == sorted(ks, reverse=True)
    assert 10 < saxton_rawls_ks(40, 20, 2.5) < 25          # franco: ordine di 15 mm/h


def test_soglia_nell_intervallo_nrcs_e_pendenza():
    r = runoff_threshold("sand", 130.0, 2)
    assert r["run_mmh"] == 51.0                              # la Ks di laboratorio non supera l'intervallo di campo
    assert runoff_threshold("clay", 1.0, 2)["run_mmh"] == 2.5
    assert slope_factor(3) == 1.0 and slope_factor(6) == 0.75 and slope_factor(10) == 0.55 and slope_factor(20) == 0.4
    assert runoff_threshold("loam", 15.0, 10)["run_mmh"] == round(15.0 * 0.55, 1)
