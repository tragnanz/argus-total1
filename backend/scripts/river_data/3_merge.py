"""Unisce le stazioni (GRDC 2025 > Dai > GRDC/UNH > GSIM), toglie i doppioni e aggiunge le serie inserite a mano.

Uso: python 3_merge.py <cartella> <uscita.json>
Nella cartella: stations.json (da 1_dai_grdc.py + nile_stations.json già convertito in src "unh"),
gsim_st.json (da 2_gsim.py), facoltativo ili_konaev.json (medie mensili Kazhydromet 2015-2023).
Doppione = stazione entro 3 km con media entro il 25%.
"""
import collections, json, math, re, sys

D, OUT = sys.argv[1], sys.argv[2]
a = json.load(open(f"{D}/stations.json")); g = json.load(open(f"{D}/gsim_st.json"))
pr = {"grdc": 0, "dai": 1, "unh": 2, "gsim": 3}
grid = collections.defaultdict(list); keep = []


def near(s):
    kx, ky = int(s["lon"] * 20), int(s["lat"] * 20)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for o in grid[(kx + dx, ky + dy)]:
                d = math.hypot((o["lat"] - s["lat"]) * 111, (o["lon"] - s["lon"]) * 111 * math.cos(math.radians(s["lat"])))
                if d < 3 and abs(o["mean"] - s["mean"]) <= 0.25 * max(o["mean"], s["mean"], 1e-6):
                    return True
    return False


for s in sorted(a + g, key=lambda s: pr[s["src"]]):
    if s["mean"] <= 0 or near(s):
        continue
    s["river"] = re.sub(r"\s+", " ", s["river"]).strip(); s["station"] = re.sub(r"\s+", " ", s["station"]).strip()
    keep.append(s); grid[(int(s["lon"] * 20), int(s["lat"] * 20))].append(s)
try:
    d = json.load(open(f"{D}/ili_konaev.json")); mm = [round(x, 2) for x in d["mm"]]
    keep.append(dict(src="kzh", id="K-ILI-KONAEV", river="Ili", station="Konaev (Kapchagay)", cc="KZ", lat=43.87, lon=77.07,
                     area=0, mean=round(sum(mm) / 12, 2), mm=mm, yrs=[2015, 2023], n=9))
except FileNotFoundError:
    pass
json.dump(keep, open(OUT, "w"), separators=(",", ":"))
print(len(keep), collections.Counter(s["src"] for s in keep))
