import sqlite3, numpy as np, pyarrow.parquet as pq, pyarrow.fs as pfs, math, os, sys, shapely, struct
TH = float(sys.argv[1]); STEP = float(sys.argv[2])   # km fra i punti lungo il tratto
fs = pfs.S3FileSystem(anonymous=True, region="us-west-2")
T = pq.read_table("geoglows-v2/tables/v2-model-table.parquet", filesystem=fs, columns=["LINKNO","DSLINKNO","DSContArea"])
L = T.column("LINKNO").to_numpy(); DS = T.column("DSLINKNO").to_numpy(); A = T.column("DSContArea").to_numpy()/1e6
sel = np.where(A >= TH)[0]
pos = {int(L[k]): i for i, k in enumerate(sel)}
rid = L[sel]; area = A[sel].astype(np.float32)
ds = np.array([pos.get(int(DS[k]), -1) for k in sel], dtype=np.int32)
zids = np.load("zarr_ids.npy"); zpos = {int(r): k for k, r in enumerate(zids)}
col = np.array([zpos.get(int(r), -1) for r in rid], dtype=np.int32)
def wkb(blob):
    # GeoPackage: header "GP", version, flags, srs_id, envelope
    flags = blob[3]; env = (flags >> 1) & 7
    n = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]
    return shapely.from_wkb(bytes(blob[8 + n:]))
c = sqlite3.connect("streams.gpkg")
plat, plon, pr = [], [], []; seen = 0
for g, lk in c.execute("select geom, LINKNO from global_streams_simplified"):
    i = pos.get(int(lk))
    if i is None or g is None: continue
    seen += 1
    ln = wkb(g)
    xy = np.asarray(ln.coords) if ln.geom_type == "LineString" else np.vstack([np.asarray(p.coords) for p in ln.geoms])
    # punti a passo ~STEP km lungo la linea (vertici inclusi)
    pts = [xy[0]]
    acc = 0.0
    for a, b in zip(xy[:-1], xy[1:]):
        dkm = math.hypot((b[1]-a[1])*111, (b[0]-a[0])*111*math.cos(math.radians(a[1])))
        acc += dkm
        if acc >= STEP:
            pts.append(b); acc = 0.0
    if len(pts) == 1 or tuple(pts[-1]) != tuple(xy[-1]): pts.append(xy[-1])
    for p in pts: plon.append(p[0]); plat.append(p[1]); pr.append(i)
print("reaches", len(sel), "with geom", seen, "points", len(pr), flush=True)
plat = np.array(plat); plon = np.array(plon); pr = np.array(pr, dtype=np.int32)
# tratti in ordine di colonna zarr: col, ds e pr diventano differenze piccole (comprimono bene)
ordr = np.argsort(col, kind="stable"); inv = np.empty_like(ordr); inv[ordr] = np.arange(len(ordr))
col = col[ordr]; area = area[ordr]; ds = np.where(ds[ordr] >= 0, inv[np.maximum(ds[ordr], 0)], -1).astype(np.int32); pr = inv[pr].astype(np.int32)
# tessere di 1°: indice tessera (lat+90)*360+(lon+180), offset in uint16 (1e-4°)
tl = np.floor(plat).astype(np.int32); tn = np.floor(plon).astype(np.int32)
tile = (tl + 90) * 360 + (tn + 180)
o = np.lexsort((pr, tile)); tile = tile[o]
dla = np.round((plat[o] - tl[o]) * 1e4).clip(0, 9999).astype(np.uint16)
dlo = np.round((plon[o] - tn[o]) * 1e4).clip(0, 9999).astype(np.uint16)
ut, start = np.unique(tile, return_index=True)
la_area = np.round(np.log10(area) * 1000).astype(np.uint16)          # log10(km²)×1000
prs = pr[o]
dpr = np.diff(prs, prepend=0).astype(np.int32)
dcol = np.diff(col, prepend=0).astype(np.int32)
dds = np.where(ds >= 0, ds - np.arange(len(ds)), -2**31).astype(np.int32)
np.savez_compressed(f"geoglows_index_{int(TH)}.npz", larea=la_area, dcol=dcol, dds=dds,
    tiles=ut.astype(np.int32), tstart=start.astype(np.int32), dla=dla, dlo=dlo, dpr=dpr)
print(os.path.getsize(f"geoglows_index_{int(TH)}.npz")/1e6, "MB")
