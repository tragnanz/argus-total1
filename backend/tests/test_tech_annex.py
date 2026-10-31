"""Allegato tecnico: si impagina e non accetta prezzi."""
from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.tech_annex import build_tech_annex  # noqa: E402

DOC = {"lang": "it", "title": "Allegato tecnico dell'impianto", "subtitle": "Prova", "project": "Prova", "reference": "ARGUS-1",
       "date": "2026-10-31", "cover_rows": [["Cliente", "Prova"]],
       "sections": [{"title": "Macchine", "table": {"header": ["Pivot", "Lunghezza (m)"], "rows": [["P1", "282"]]}},
                    {"title": "Energia", "kv": [["Potenza installata", "90 kW"]], "note": "Nota."}]}


def test_si_impagina_senza_planimetria():
    pdf = build_tech_annex(DOC, "0.0.0")
    assert pdf[:4] == b"%PDF"


def test_un_prezzo_fa_fallire_l_allegato():
    doc = {**DOC, "sections": [{"title": "Energia", "kv": [["Costo", "1.000 €"]]}]}
    with pytest.raises(ValueError):
        build_tech_annex(doc, "0.0.0")
