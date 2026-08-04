"""Libreria di processing geospaziale per l'analisi satellitare storica.

Cuore analitico condiviso da API e worker. Indipendente dal framework web:
riceve stack di indici (array NumPy per stagione) + una geometria d'impianto
e produce la mappa delle anomalie ricorrenti, le zone e l'aggregazione per
la geometria dell'impianto (pivot polare / banded along-cross).
"""
__all__ = ["geometry", "normalize", "anomaly", "pipeline", "synthetic"]
