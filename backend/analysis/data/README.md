# river_stations.json

Medie mensili OSSERVATE di portata (m³/s) usate da `analysis/river_obs.py` per correggere GloFAS.
Campi: src, id, river, station, cc, lat, lon, area (km²), mean, mm (12 medie mensili gen→dic), yrs, n (anni).
Climatologia sul periodo 1991→ultimo anno se la stazione ha almeno 10 anni lì, altrimenti sull'intero record.

- `dai`: Dai, A. et al. 2026, Dai Downstream River Flow and Continental Discharge Dataset,
  Zenodo 10.5281/zenodo.17379716 (CC BY 4.0). Stazione più a valle dei 936 maggiori fiumi.
- `grdc`: GRDC, River Discharge Dataset for the WMO State of Global Water Resources Report 2025,
  Zenodo 10.5281/zenodo.23587317 (licenze dei singoli fornitori nazionali; esclusa l'Italia/ARPAE,
  CC BY-NC-SA, non compatibile con l'uso commerciale).
- `unh`: GRDC / UNH Composite Runoff Fields (www.compositerunoff.sr.unh.edu), stazioni storiche del
  bacino del Nilo; coordinate approssimate.
