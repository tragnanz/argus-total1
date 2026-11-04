import zipfile, io, json, sys, re, math
D = sys.argv[1]
z = zipfile.ZipFile(f"{D}/gsim_idx.zip")
names = [n for n in z.namelist() if n.endswith(".mon")]
out = []
for k, n in enumerate(names):
    t = z.read(n).decode("latin-1")
    meta = dict(re.findall(r"^# (\S+)\s*:\s*(.*?)\s*:\s*\[", t, re.M))
    by = [[] for _ in range(12)]; lows = [[] for _ in range(12)]; years = set()
    for line in t.splitlines():
        if not line[:1].isdigit():
            continue
        p = [x.strip() for x in line.split(",")]
        try:
            if p[1] == "NA" or int(p[9]) > 3:
                continue
            m = int(p[0][5:7]) - 1; v = float(p[1])
        except Exception:
            continue
        if v < 0:
            continue
        by[m].append(v); years.add(int(p[0][:4]))
        if p[7] != "NA":
            lows[m].append(float(p[7]))
    if len(years) < 5 or any(len(b) < 4 for b in by):
        continue
    mm = [sum(b) / len(b) for b in by]
    try:
        lat, lon = float(meta["latitude"]), float(meta["longitude"])
    except Exception:
        continue
    try: area = int(float(meta.get("area", "0")))
    except Exception: area = 0
    out.append(dict(src="gsim", id="S" + meta["gsim.no"], river=meta.get("river", "").title(), station=meta.get("station", "").title(),
                    cc=meta.get("country", ""), lat=round(lat, 4), lon=round(lon, 4), area=area,
                    mean=round(sum(mm) / 12, 3), mm=[round(x, 3) for x in mm], yrs=[min(years), max(years)], n=len(years)))
    if k % 5000 == 0: print(k, len(out), flush=True)
json.dump(out, open(f"{D}/gsim_st.json", "w"), separators=(",", ":"))
print("gsim", len(out))
