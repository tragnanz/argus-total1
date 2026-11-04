# river_stations.json

Medie mensili OSSERVATE di portata (m³/s) di ~25.000 stazioni idrometriche in 151 paesi, usate da
`analysis/river_obs.py` per correggere GloFAS sullo stesso fiume.
Campi: src, id, river, station, cc, lat, lon, area (km²), mean, mm (12 medie mensili gen→dic), yrs, n (anni),
sc (facoltativo: celle GloFAS 2014-2023 già lette alla stazione, [lat, lon, media, 12 medie mensili]).
Doppioni (stazioni entro 3 km con media entro il 25%) tolti, con precedenza GRDC 2025 > Dai > GRDC/UNH > GSIM.

Fonti:
- `grdc`: GRDC, River Discharge Dataset for the WMO State of Global Water Resources Report 2025,
  Zenodo 10.5281/zenodo.23587317 (licenze dei fornitori nazionali; esclusi i dati italiani ARPAE, CC BY-NC-SA).
  Climatologia 1991-2025.
- `dai`: Dai, A. et al. 2026, Dai Downstream River Flow and Continental Discharge Dataset,
  Zenodo 10.5281/zenodo.17379716 (CC BY 4.0).
- `unh`: GRDC / UNH Composite Runoff Fields (www.compositerunoff.sr.unh.edu), stazioni storiche del Nilo,
  coordinate approssimate.
- `gsim`: Do, H.X., Gudmundsson, L., Leonard, M., Westra, S. (2018) e Gudmundsson, L. et al. (2018),
  The Global Streamflow Indices and Metadata Archive (GSIM), PANGAEA 10.1594/PANGAEA.887477 e
  10.1594/PANGAEA.887470, CC BY-SA 3.0. Medie dei mesi con al massimo 3 giorni mancanti.

Questo file di dati, in quanto derivato anche da GSIM, è distribuito con licenza CC BY-SA 3.0.
