"""Astrazione della geometria d'impianto.

`PlantGeometry` è l'interfaccia comune; `PivotGeometry` (coordinate polari) e
`BandedGeometry` (coordinate cartesiane along/cross, per impianti lineari,
rotoloni e goccia) sono le due implementazioni. Tutto ciò che sta a valle
(zonazione, cause, priorità) lavora sull'output di `aggregate()` senza sapere
quale impianto lo ha prodotto.
"""
from .grid import Grid
from .base import PlantGeometry, build_geometry
from .pivot import PivotGeometry
from .banded import BandedGeometry

__all__ = ["Grid", "PlantGeometry", "PivotGeometry", "BandedGeometry", "build_geometry"]
