"""Turn the simulator's output into the small CSVs the dashboard reads.

Run from the project folder:
    python scripts/simulate_derconnect.py --out sim_data
    python scripts/prepare_dashboard_data.py --sim sim_data --out data
"""
import argparse, os
import numpy as np, pandas as pd
ap = argparse.ArgumentParser()
ap.add_argument("--sim", default="sim_data"); ap.add_argument("--out", default="data")
args = ap.parse_args()
S, O = args.sim, args.out
os.makedirs(O, exist_ok=True)
r = pd.read_csv(f"{S}/readings.csv.gz", parse_dates=["timestamp"])
m = pd.read_csv(f"{S}/meters.csv"); b = pd.read_csv(f"{S}/buildings.csv")
ev = pd.read_csv(f"{S}/events.csv", parse_dates=["start", "end"])
w = pd.read_csv(f"{S}/weather.csv", parse_dates=["timestamp"])
meta = m.merge(b[["building_id", "zone"]], on="building_id")
r = r.merge(meta[["meter_id", "building_id", "zone", "load_type"]], on="meter_id")
iso = lambda s: s.dt.strftime("%Y-%m-%dT%H:%M")

# events
e = ev.copy()
e["start"], e["end"] = iso(e.start), iso(e.end)
e["is_anomaly"] = e.is_anomaly.map(lambda v: "true" if str(v) == "True" else "false")
e["active"] = e.active.map(lambda v: "true" if str(v) == "True" else "false")
e["excess_kwh"] = e.excess_kwh.round(0).astype(int)
e["peak_dev_pct"] = e.peak_dev_pct.round(0).astype(int)
e["zone"] = e.zone.fillna("All zones")
for c in ["building_id", "meter_id", "load_type"]: e[c] = e[c].fillna("")
e["building_name"] = e.building_id.map(dict(zip(b.building_id, b.name))).fillna("")
def location(r):
    if r.scope == "meter": return f"{r.building_name} · {r.meter_id}"
    if r.scope == "building": return r.building_name
    if r.scope == "zone": return r.zone
    return "Whole campus"
e.insert(e.columns.get_loc("scope") + 1, "location", e.apply(location, axis=1))
e.drop(columns=["kw_normal"], errors="ignore").to_csv(f"{O}/events.csv", index=False)

# buildings + completeness
comp = r.groupby("building_id").kw.apply(lambda s: round(100 * s.notna().mean(), 2))
bb = b.copy(); bb["meters"] = bb.building_id.map(m.groupby("building_id").size())
bb["completeness_pct"] = bb.building_id.map(comp)
bb.to_csv(f"{O}/buildings.csv", index=False)

# zone hourly + temperature
r["hour"] = r.timestamp.dt.floor("h")
# average kW in each hour: total load per 15-min slot, then the mean of the slots present
# (so a partial latest hour is not under-counted)
def hourly(keys):
    slot = r.groupby(["timestamp", "hour"] + keys)[["kw", "expected_kw"]].sum(min_count=1).reset_index()
    return slot.groupby(["hour"] + keys)[["kw", "expected_kw"]].mean().reset_index()
zh = hourly(["zone"])
wt = w.assign(hour=w.timestamp.dt.floor("h")).groupby("hour").outdoor_temp_c.mean()
zh["temp_c"] = zh.hour.map(wt).round(1)
zh["ts"] = iso(zh.hour); zh[["kw", "expected_kw"]] = zh[["kw", "expected_kw"]].round(1)
zh[["ts", "zone", "kw", "expected_kw", "temp_c"]].to_csv(f"{O}/zone_hourly.csv", index=False)

# building hourly + decomposition (trend = 7-day centered mean, seasonal = hour-of-week mean of detrended)
bh = hourly(["building_id"])
out = []
for bid, g in bh.groupby("building_id"):
    g = g.sort_values("hour").copy()
    kw = g.kw.interpolate(limit_direction="both")
    g["trend_kw"] = kw.rolling(168, center=True, min_periods=84).mean()
    how = g.hour.dt.dayofweek * 24 + g.hour.dt.hour
    det = kw - g.trend_kw
    g["seasonal_kw"] = how.map(det.groupby(how).mean())
    g["residual_kw"] = kw - g.trend_kw - g.seasonal_kw
    out.append(g)
bh = pd.concat(out); bh["ts"] = iso(bh.hour)
cols = ["kw", "expected_kw", "trend_kw", "seasonal_kw", "residual_kw"]
bh[cols] = bh[cols].round(1)
bh[["ts", "building_id"] + cols].to_csv(f"{O}/building_hourly.csv", index=False)

# building daily, wide by load type
r["date"] = r.timestamp.dt.strftime("%Y-%m-%d")
lt = (r.groupby(["date", "building_id", "load_type"]).kw.sum(min_count=1) / 4).unstack()
lt.columns = [f"{c.lower()}_kwh" for c in lt.columns]
tot = r.groupby(["date", "building_id"])[["kw", "expected_kw"]].sum(min_count=1) / 4
bd = lt.join(tot.rename(columns={"kw": "kwh", "expected_kw": "expected_kwh"})).reset_index()
bd["dev_pct"] = (100 * (bd.kwh - bd.expected_kwh) / bd.expected_kwh).round(1)
bd = bd.round(0); bd["dev_pct"] = (100 * (bd.kwh - bd.expected_kwh) / bd.expected_kwh).round(1)
bd.to_csv(f"{O}/building_daily.csv", index=False)

# event traces + event-day overlays
r = r.set_index("timestamp")
traces, overlays = [], []
def series(row):
    if row.scope == "meter": q = r[r.meter_id == row.meter_id]
    elif row.scope == "building": q = r[r.building_id == row.building_id]
    elif row.scope == "zone": q = r[r.zone == row.zone]
    else: q = r
    return q.groupby(level=0)[["kw", "expected_kw"]].sum(min_count=1)
for _, row in ev.iterrows():
    s = series(row)
    dur = (row.end - row.start).total_seconds() / 3600
    pad = pd.Timedelta(hours=12) if dur <= 1 else pd.Timedelta(days=1 if dur <= 72 else 3)
    t = s.loc[row.start - pad: row.end + pad]
    if dur > 72: t = t.resample("h").mean()
    t = t.reset_index().rename(columns={"timestamp": "ts"})
    t["event_id"] = row.event_id; t["ts"] = iso(t.ts)
    traces.append(t[["event_id", "ts", "kw", "expected_kw"]].round(1))
    win = s.loc[row.start:row.end]
    dd = (win.kw - win.expected_kw).abs().dropna()
    peak = dd.idxmax() if len(dd) else row.start
    day = pd.Timestamp(peak).normalize()
    for k, label in enumerate(["Event day", "1 week before", "2 weeks before", "3 weeks before", "4 weeks before"]):
        d = day - pd.Timedelta(weeks=k)
        x = s.loc[d: d + pd.Timedelta(hours=23, minutes=45)]
        if len(x) < 96 and k > 0: continue  # the event day may be today, still in progress
        overlays.append(pd.DataFrame({"event_id": row.event_id, "series": label, "day": d.strftime("%Y-%m-%d"),
                                      "hour": (np.arange(len(x)) / 4), "kw": x.kw.round(1).values}))
pd.concat(traces).to_csv(f"{O}/event_traces.csv", index=False)
pd.concat(overlays).to_csv(f"{O}/event_overlay.csv", index=False)
