import glob, re, json, sys, numpy as np, netCDF4 as nc
D=sys.argv[1]; out=[]
def clim(dates, vals, y0=1991):
    """dates: list of (y,m); vals m3/s. Prefer >=y0 if >=10 full years-ish."""
    a=[(y,m,v) for (y,m),v in zip(dates,vals) if v is not None and np.isfinite(v) and v>=0]
    rec=[x for x in a if x[0]>=y0]
    if len({x[0] for x in rec})<10: rec=a
    by=[[x[2] for x in rec if x[1]==m] for m in range(1,13)]
    if any(len(b)<5 for b in by): return None
    mm=[float(np.mean(b)) for b in by]; yrs=sorted({x[0] for x in rec})
    return mm, [yrs[0],yrs[-1]], len(yrs)
# Dai
d=nc.Dataset(f"{D}/dai.nc"); d.set_auto_mask(True)
def s(v,i):
    x=d.variables[v][i]; x=x.compressed() if np.ma.isMA(x) else x
    t=b"".join(x).decode("latin-1"); t=re.split(r"[^\x20-\x7e]",t)[0]
    return re.sub(r"\s+i+$","",t).strip()
T=d.variables["time"][:]; dates=[(int(t)//100,int(t)%100) for t in T]
F=d.variables["FLOW"][:]
for i in range(F.shape[1]):
    col=F[:,i]; vals=[None if np.ma.is_masked(v) else float(v) for v in col]
    c=clim(dates,vals)
    if not c: continue
    mm,yrs,n=c
    out.append(dict(src="dai",id=f"D{int(d['id'][i])}",river=s("riv_name",i),station=s("stn_name",i).split(",")[0].strip(),
        cc=s("ct_name",i)[:12],lat=round(float(d['lat'][i]),4),lon=round(float(d['lon'][i]),4),area=int(d['area_stn'][i]),
        mean=round(float(np.mean(mm)),2),mm=[round(x,2) for x in mm],yrs=yrs,n=n))
nd=len(out)
# GRDC SGWRR 2025 (esclusi dati con licenza non commerciale)
for f in glob.glob(f"{D}/g/Monthly/*.txt"):
    t=open(f,encoding="latin-1").read()
    g=lambda k: re.search(k+r":\s*(.*)",t).group(1).strip()
    if g("Country")=="IT": continue
    rows=re.findall(r"^(\d{4})-(\d{2})-\d{2};[^;]*;\s*(-?[\d.]+);\s*(-?[\d.]+)",t,re.M)
    dates=[(int(y),int(m)) for y,m,_,_ in rows]
    vals=[]
    for _,_,o,c in rows:
        v=float(o) if float(o)>-990 else float(c)
        vals.append(None if v<=-990 else v)
    c=clim(dates,vals)
    if not c: continue
    mm,yrs,n=c
    try: area=float(re.search(r"Catchment area[^:]*:\s*([\d.]+)",t).group(1))
    except: area=0
    out.append(dict(src="grdc",id=f"G{g('GRDC-No.')}",river=g("River").title(),station=g("Station").title(),cc=g("Country"),
        lat=round(float(g(r"Latitude \(DD\)")),4),lon=round(float(g(r"Longitude \(DD\)")),4),area=int(area),
        mean=round(float(np.mean(mm)),2),mm=[round(x,2) for x in mm],yrs=yrs,n=n))
print("dai",nd,"grdc",len(out)-nd)
json.dump(out,open(f"{D}/stations.json","w"),separators=(",",":"))
