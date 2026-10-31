"""Relazione tecnica generale per il cliente: si impagina (Agrostar e Nabu) e rifiuta i prezzi."""
from __future__ import annotations

import io
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.explanatory_note import build_note  # noqa: E402

DOC = {"lang": "it", "brand": "agrostar", "cover_title": "Impianto di irrigazione\na pivot centrale", "title": "Relazione tecnica generale",
       "revision": "Rev 01", "date": "31/10/2026", "client": "Cliente", "recipient_label": "Alla cortese attenzione di", "recipient": ["Progetto"],
       "header": "Agrostar srl <> Cliente – Relazione tecnica generale – Rev 01 – 31/10/2026", "toc_title": "Indice", "figure_label": "Figura",
       "chapters": [{"title": "Introduzione", "blocks": [{"p": "Testo."}, {"bullets": ["uno;", "due."]}]},
                    {"title": "Nota tecnica", "blocks": [{"h": "1.1 Sottocapitolo", "toc": True}, {"p": "Testo."},
                                                         {"table": {"header": ["Mese", "ET₀ (mm)"], "rows": [["gen", "22"]]}}, {"numbered": ["a", "b"]}]}]}


@pytest.mark.parametrize("brand", ["agrostar", "nabu"])
def test_si_impagina(brand):
    from pypdf import PdfReader
    pdf = build_note({**DOC, "brand": brand}, "0.0.0")
    testo = "".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)
    assert "Indice" in testo and "1.1 Sottocapitolo" in testo and "Relazione tecnica generale" in testo


def test_un_prezzo_fa_fallire_la_relazione():
    doc = {**DOC, "chapters": [{"title": "Costi", "blocks": [{"p": "Il pivot costa 50.000 €."}]}]}
    with pytest.raises(ValueError):
        build_note(doc, "0.0.0")
