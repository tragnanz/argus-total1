"""PDF del confronto tra varianti e ortofoto per il .ceres (senza rete: niente tessere)."""
from __future__ import annotations

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.variants_pdf import build_variants_pdf  # noqa: E402


def _pdf(n_cols: int, n_qty: int = 40) -> bytes:
    rows = [{"label": f"Voce {i}", "cells": [{"v": "1"}] + [{"v": "2", "d": "+1", "s": 1}] * (n_cols - 1)} for i in range(20)]
    qty = [{"label": "Pivot", "head": True}] + [{"label": f"Campata {i} (n.)", "values": ["3"] * n_cols} for i in range(n_qty)]
    return build_variants_pdf("Confronto tra varianti", "Cliente · Progetto", "2026-10-31", "Nota di prova.",
                              [f"V{i}" for i in range(n_cols)], rows, "Computo metrico", qty, "0.0.0")


def test_pdf_si_apre_e_ha_le_pagine_attese():
    from pypdf import PdfReader
    pdf = _pdf(4)
    assert pdf[:4] == b"%PDF"
    r = PdfReader(io.BytesIO(pdf))
    testo = "".join(p.extract_text() for p in r.pages)
    assert "Confronto tra varianti" in testo and "Computo metrico" in testo
    assert "+1" in testo                       # le differenze rispetto allo stato attuale


def test_dodici_colonne_stanno_in_orizzontale():
    from pypdf import PdfReader
    r = PdfReader(io.BytesIO(_pdf(12, 5)))
    w, h = float(r.pages[0].mediabox.width), float(r.pages[0].mediabox.height)
    assert w > h                               # A4 orizzontale


def test_niente_prezzi_nel_pdf():
    from pypdf import PdfReader
    r = PdfReader(io.BytesIO(_pdf(3)))
    assert "€" not in "".join(p.extract_text() for p in r.pages)
