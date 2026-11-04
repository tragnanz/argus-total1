# Rigenerare i dati dei fiumi

Servono solo se si aggiornano le fonti. Scaricare prima i file originali in una cartella di lavoro.

1. `1_dai_grdc.py <cartella>` — da `dai.nc` (Zenodo 10.5281/zenodo.17379716) e `grdc.zip` estratto in `g/`
   (Zenodo 10.5281/zenodo.23587317) scrive `stations.json`. Le stazioni del Nilo GRDC/UNH (`nile_stations.json`,
   lette a mano da compositerunoff.sr.unh.edu) vanno aggiunte come `src: "unh"`.
2. `2_gsim.py <cartella>` — da `gsim_idx.zip` (PANGAEA 10.1594/PANGAEA.887470) scrive `gsim_st.json`.
3. `3_merge.py <cartella> ../../analysis/data/river_stations.json` — unisce, toglie i doppioni, aggiunge Kazhydromet.
4. `4_geoglows_index.py 1000 4` — da `tables/v2-model-table.parquet`, `hydrography-global/global_streams_simplified.gpkg`
   e `retrospective/monthly-timeseries.zarr/river_id` (bucket pubblico `geoglows-v2`, salvato come `zarr_ids.npy`)
   scrive `geoglows_index_1000.npz`; poi aggiungere l'array `rid` (= `zarr_ids[col]`) e copiarlo in
   `analysis/data/geoglows_index.npz`.

Dipendenze solo per questi script: netCDF4, pyarrow, shapely.
