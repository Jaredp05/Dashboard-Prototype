"""
Simulated DERConnect-style campus energy data for an operations dashboard prototype.

Audience: UCSD facilities / energy manager. Focus: sub-grid (zone) + building + submeter
operations view, with anomalies planted per Lai et al. outlier types and harmless
look-alikes per Burgos et al. (legitimate changes that should NOT be treated as faults).

Shape mirrors DERConnect: 24 buildings, 236 submeters tagged AHU / lighting / plug / misc.
Real DERConnect data is 2-second; we simulate at 15-minute resolution (change FREQ_MIN)
to keep files small. Everything is seeded, so teammates get identical data.

Outputs (in ./sim_data/):
  zones.csv            sub-grid zones
  buildings.csv        building_id, name, type, zone, sqft
  meters.csv           meter_id, building_id, load_type, rated_kw
  weather.csv          timestamp, outdoor_temp_c
  calendar.csv         date, day_type, note
  readings.csv.gz      timestamp, meter_id, kw, kw_normal, expected_kw   (meter level)
  building_hourly.csv  timestamp, building_id, zone, load_type, kw, kw_normal, expected_kw
  zone_hourly.csv      timestamp, zone, kw, kw_normal, expected_kw
  events.csv           ground-truth event labels (faults AND harmless look-alikes)

Column meanings:
  kw          what the meter reports (includes faults and bad data)
  kw_normal   counterfactual "no fault" load (includes legitimate changes) -> excess kWh
  expected_kw what a simple model would predict: median of same weekday+slot, prior 4 weeks
              (residual = kw - expected_kw is what a dashboard/detector would actually see)

The window ends at --now (default 2026-10-26 11:00), so a handful of faults are still in
progress at the last reading: events.csv marks them active=true. This lets a dashboard show
what is happening "right now".

Usage:  python simulate_derconnect.py [--seed 7] [--weeks 10] [--now "2026-10-26 11:00"] [--out sim_data]
"""
import argparse
import os
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=RuntimeWarning)  # nanmedian of empty slices

FREQ_MIN = 15
SLOTS = 24 * 60 // FREQ_MIN  # slots per day
DT_H = FREQ_MIN / 60
START = None  # set in main(): the data window ends at --now, so the last readings are "live"
NOW_DEFAULT = "2026-10-26 11:00"  # campus local time of the most recent reading

ZONES = ["SG-North", "SG-Central", "SG-East", "SG-South"]
BUILDING_TYPES = (["lab"] * 6 + ["classroom"] * 5 + ["office"] * 5 +
                  ["library"] * 2 + ["residential"] * 4 + ["recreation"] * 2)
KW_PER_SQFT = {"lab": 0.014, "classroom": 0.006, "office": 0.006,
               "library": 0.007, "residential": 0.004, "recreation": 0.008}
LOAD_SHARE = {  # share of building peak by load type
    "lab": {"AHU": 0.50, "lighting": 0.12, "plug": 0.25, "misc": 0.13},
    "default": {"AHU": 0.40, "lighting": 0.20, "plug": 0.25, "misc": 0.15},
}
N_METERS = 236


# ----------------------------------------------------------------------------- helpers
def sig(x):
    return 1 / (1 + np.exp(-x))


def window(h, a, b, k=2.5):
    """Smooth on-window between hours a and b."""
    return sig((h - a) * k) * sig((b - h) * k)


def occupancy(btype, h, off):
    """Occupancy 0..1 by building type. `off` = weekend or holiday."""
    if btype in ("office", "classroom"):
        work = window(h, 7.5, 18) * 0.95
        if btype == "classroom":
            work = np.maximum(work, window(h, 7.5, 21.5) * 0.45)
        return np.where(off, 0.05 + 0.05 * window(h, 10, 16), work + 0.03)
    if btype == "lab":
        return np.where(off, 0.30 + 0.15 * window(h, 10, 17), 0.35 + 0.55 * window(h, 8, 19))
    if btype == "library":
        return np.where(off, 0.05 + 0.6 * window(h, 10, 22), 0.05 + 0.85 * window(h, 7, 24, 3))
    if btype == "residential":
        base = 0.3 + 0.35 * window(h, 6.5, 9) + 0.6 * window(h, 17, 23.5) + 0.1 * window(h, 9, 17)
        return np.where(off, base + 0.1 * window(h, 9, 17), base)
    if btype == "recreation":
        base = 0.1 + 0.4 * window(h, 6, 9) + 0.3 * window(h, 9, 16) + 0.8 * window(h, 16, 21) * 0.9
        return np.where(off, 0.1 + 0.5 * window(h, 8, 20), base)
    raise ValueError(btype)


def hvac_schedule(btype, h, off):
    if btype == "lab":
        return np.ones_like(h)  # labs run 24/7 (ventilation)
    if btype in ("residential",):
        return 0.5 + 0.5 * window(h, 6, 23.5)
    if btype == "recreation":
        return window(h, 5.5, 22.5)
    if btype == "library":
        return np.where(off, window(h, 9, 22.5), window(h, 6, 24.5))
    return np.where(off, 0.08, window(h, 6, 19.5))  # office/classroom setback off-hours


def ar1(rng, n, phi=0.97, sd=0.02):
    e = rng.normal(0, sd * np.sqrt(1 - phi ** 2), n)
    out = np.empty(n)
    out[0] = e[0]
    for i in range(1, n):
        out[i] = phi * out[i - 1] + e[i]
    return out


# ----------------------------------------------------------------------------- build
def main(seed=7, weeks=10, out="sim_data", now=NOW_DEFAULT):
    global START
    NOW = pd.Timestamp(now).floor(f"{FREQ_MIN}min")
    START = NOW.normalize() - pd.Timedelta(days=weeks * 7 - 1)  # today is the last day
    rng = np.random.default_rng(seed)
    n_days = weeks * 7
    n = n_days * SLOTS
    ts = pd.date_range(START, periods=n, freq=f"{FREQ_MIN}min")
    h = ts.hour.values + ts.minute.values / 60
    dow = ts.dayofweek.values
    day = np.repeat(np.arange(n_days), SLOTS)
    dates = pd.date_range(START, periods=n_days, freq="D")

    all_holidays = {pd.Timestamp("2026-07-03"): "Independence Day observed (campus holiday)",
                    pd.Timestamp("2026-09-07"): "Labor Day (campus holiday)",
                    pd.Timestamp("2026-11-11"): "Veterans Day (campus holiday)",
                    pd.Timestamp("2026-11-26"): "Thanksgiving (campus holiday)",
                    pd.Timestamp("2026-11-27"): "Thanksgiving break (campus holiday)",
                    pd.Timestamp("2026-12-25"): "Winter break (campus holiday)"}
    holidays = {d: v for d, v in all_holidays.items() if dates[0] <= d < dates[-1]}
    c_now = int((NOW - START) / pd.Timedelta(minutes=FREQ_MIN)) + 1  # slots up to and including NOW
    today = n_days - 1
    holiday_day = np.array([d in holidays for d in dates])
    off = (dow >= 5) | holiday_day[day]

    def idx(d, hour):  # slot index for day d at hour (float)
        return int(d * SLOTS + round(hour * SLOTS / 24))

    def last_dow(weekday, days_back):  # latest day index with that weekday, >= days_back days ago
        d = today - days_back
        while dates[d].dayofweek != weekday:
            d -= 1
        return d

    events = []

    def add_event(**kw):
        events.append(kw)

    # --- weather: San Diego fall, cooling slowly, with a heat wave (harmless driver)
    temp = (23 - 5 * np.arange(n) / n + 4 * np.sin(2 * np.pi * (h - 9) / 24)
            + ar1(rng, n, 0.995, 1.5))
    hw_d = 12  # heat wave days 12-14
    temp[hw_d * SLOTS:(hw_d + 3) * SLOTS] += 7 * np.sin(np.linspace(0, np.pi, 3 * SLOTS))
    add_event(start=ts[hw_d * SLOTS], end=ts[(hw_d + 3) * SLOTS - 1], scope="campus", zone=None,
              building_id=None, meter_id=None, load_type="AHU", lai_type="trend",
              category="Weather-driven load", is_anomaly=False,
              explanation="Heat wave: AHU cooling load rose with outdoor temperature (expected behavior).")
    for d_ts, note in holidays.items():
        d = (d_ts - START).days
        add_event(start=ts[d * SLOTS], end=ts[(d + 1) * SLOTS - 1], scope="campus", zone=None,
                  building_id=None, meter_id=None, load_type=None, lai_type="contextual",
                  category="Schedule change", is_anomaly=False,
                  explanation=f"{note}: low occupancy, weekday looks like a weekend.")

    # --- zones, buildings, meters
    btypes = list(rng.permutation(BUILDING_TYPES))
    counters = {}
    buildings = []
    for i, bt in enumerate(btypes):
        counters[bt] = counters.get(bt, 0) + 1
        buildings.append(dict(building_id=f"B{i + 1:02d}", name=f"{bt.title()} {counters[bt]}",
                              type=bt, zone=ZONES[i % 4],
                              sqft=int(rng.uniform(25_000, 180_000) // 1000 * 1000)))
    bdf = pd.DataFrame(buildings)

    # meters: 7 baseline per building (2 AHU, 2 lighting, 2 plug, 1 misc) + extras by size
    per_b = {b: ["AHU", "AHU", "lighting", "lighting", "plug", "plug", "misc"] for b in bdf.building_id}
    extra = N_METERS - 7 * len(bdf)
    w = bdf.sqft.values / bdf.sqft.sum()
    for b in rng.choice(bdf.building_id, size=extra, p=w):
        per_b[b].append(rng.choice(["AHU", "lighting", "plug", "misc"], p=[0.35, 0.2, 0.3, 0.15]))
    meters = []
    for _, b in bdf.iterrows():
        peak = b.sqft * KW_PER_SQFT[b.type]
        share = LOAD_SHARE.get(b.type, LOAD_SHARE["default"])
        for lt in ["AHU", "lighting", "plug", "misc"]:
            k = per_b[b.building_id].count(lt)
            split = rng.dirichlet(np.ones(k) * 4)
            for j in range(k):
                meters.append(dict(meter_id=f"{b.building_id}-{lt.upper()[:4]}-{j + 1:02d}",
                                   building_id=b.building_id, load_type=lt,
                                   rated_kw=round(peak * share[lt] * split[j], 1)))
    mdf = pd.DataFrame(meters)
    btype = dict(zip(bdf.building_id, bdf.type))
    bzone = dict(zip(bdf.building_id, bdf.zone))

    # --- normal load per meter (includes legitimate changes)
    occ_cache = {bt: occupancy(bt, h, off) for bt in set(btypes)}
    sched_cache = {bt: hvac_schedule(bt, h, off) for bt in set(btypes)}
    normal = {}
    for _, m in mdf.iterrows():
        bt = btype[m.building_id]
        occ, sch, cap = occ_cache[bt], sched_cache[bt], m.rated_kw
        if m.load_type == "AHU":
            base = 0.45 if bt == "lab" else 0.10
            load = base + sch * (0.40 + 0.035 * np.clip(temp - 16, 0, None))
        elif m.load_type == "lighting":
            load = 0.06 + 0.88 * np.clip(occ * 1.15, 0, 1) ** 0.5
        elif m.load_type == "plug":
            load = 0.28 + 0.6 * occ
        else:  # misc: pumps/compressors that cycle normally (~2h period)
            period = int(rng.integers(6, 10))
            phase = int(rng.integers(0, period))
            cyc = ((np.arange(n) + phase) % period) < period // 2
            load = 0.35 + 0.25 * cyc + 0.1 * occ
        noise = (1 + ar1(rng, n, 0.97, 0.03)) * (1 + rng.normal(0, 0.02, n))
        normal[m.meter_id] = np.clip(cap * load * noise, 0, None)

    def meters_of(b, lt=None):
        q = mdf[mdf.building_id == b]
        return list(q[q.load_type == lt].meter_id) if lt else list(q.meter_id)

    def bldgs(types):
        return list(bdf[bdf.type.isin(types)].building_id)

    # Harmless look-alikes baked into normal load (Burgos: not every deviation is a fault)
    rec = rng.choice(bldgs(["recreation"]))
    d = last_dow(4, 17)  # Friday evening event
    s, e = idx(d, 18), idx(d, 23)
    for mid in meters_of(rec, "plug") + meters_of(rec, "lighting"):
        normal[mid][s:e] *= rng.uniform(1.8, 2.4)
    add_event(start=ts[s], end=ts[e - 1], scope="building", zone=bzone[rec], building_id=rec,
              meter_id=None, load_type="plug", lai_type="contextual", category="Scheduled event",
              is_anomaly=False, explanation="Scheduled evening event (booked in facilities calendar).")

    cls = rng.choice(bldgs(["classroom"]))
    mid = meters_of(cls, "plug")[0]
    d = last_dow(0, 35)
    normal[mid][d * SLOTS:] *= 1.35
    add_event(start=ts[d * SLOTS], end=ts[n - 1], scope="meter", zone=bzone[cls], building_id=cls,
              meter_id=mid, load_type="plug", lai_type="trend", category="Legitimate load change",
              is_anomaly=False, explanation="New instructional computer lab installed: permanent "
              "+35% plug load. Baseline adapts after ~4 weeks.")

    lab = rng.choice(bldgs(["lab"]))
    mid = meters_of(lab, "AHU")[0]
    d = last_dow(1, 13)
    s, e = idx(d, 1), idx(d, 3.5)
    normal[mid][s:e] *= 1.6
    add_event(start=ts[s], end=ts[e - 1], scope="meter", zone=bzone[lab], building_id=lab,
              meter_id=mid, load_type="AHU", lai_type="global", category="Planned maintenance",
              is_anomaly=False, explanation="Planned AHU commissioning test (work order on file).")

    kw = {k: v.copy() for k, v in normal.items()}

    # ----------------------------------------------------------------- fault anomalies
    work_days = [d for d in range(28, today) if not off[d * SLOTS]]
    all_days = list(range(28, today))  # after 4-week baseline warm-up, before today

    def pick_meter(types=None, lts=None):
        q = mdf
        if types:
            q = q[q.building_id.isin(bldgs(types))]
        if lts:
            q = q[q.load_type.isin(lts)]
        return q.sample(1, random_state=int(rng.integers(10**9))).iloc[0]

    busy = {}  # meter_id -> list of (s, e) so planted faults never overlap on one meter

    def pick_free(types, lts, make_window, tries=200):
        for _ in range(tries):
            m = pick_meter(types, lts)
            s, e = make_window(m)
            if all(e <= a or s >= b for a, b in busy.get(m.meter_id, [])):
                busy.setdefault(m.meter_id, []).append((s, e))
                return m, s, e
        raise RuntimeError("could not place event")

    def meter_event(m, s, e, lai, cat, expl):
        add_event(start=ts[s], end=ts[min(e, n) - 1], scope="meter", zone=bzone[m.building_id],
                  building_id=m.building_id, meter_id=m.meter_id, load_type=m.load_type,
                  lai_type=lai, category=cat, is_anomaly=True, explanation=expl)

    saturdays = [d for d in all_days if dow[d * SLOTS] == 5 and d + 2 <= today
                 and not off[(d - 1) * SLOTS]]  # Friday before must be a normal workday

    # 1) Global / point outliers: short demand spikes
    for _ in range(8):
        def win(m):
            s = int(rng.choice(all_days)) * SLOTS + int(rng.integers(0, SLOTS))
            return s, min(s + int(rng.integers(1, 3)), n)
        m, s, e = pick_free(None, ["AHU", "plug", "misc"], win)
        kw[m.meter_id][s:e] *= rng.uniform(2.5, 4.0)
        meter_event(m, s, e, "global", "Abnormal peak demand",
                    "Sudden demand spike well above any historical value; check for equipment "
                    "inrush, fault, or simultaneous startup.")

    # 2) Contextual: AHU running overnight at daytime level (normal value, wrong time)
    for _ in range(5):
        nights = int(rng.integers(1, 5))
        def win(m):
            d0 = int(rng.choice([d for d in work_days if d < n_days - 5]))
            return idx(d0, 22), idx(d0 + nights, 6)
        m, s, e = pick_free(["office", "classroom", "library"], ["AHU"], win)
        x = kw[m.meter_id]
        day_level = np.nanpercentile(normal[m.meter_id][s - 7 * SLOTS:s], 85)  # typical occupied level
        x[s:e] = np.maximum(x[s:e], day_level * rng.normal(1, 0.03, e - s))
        meter_event(m, s, e, "contextual", "Equipment schedule fault",
                    f"AHU ran overnight for {nights} night(s) at daytime level; likely BMS "
                    "schedule override left on.")

    # 2b) Contextual: lighting left on over a weekend
    for _ in range(3):
        def win(m):
            d0 = int(rng.choice(saturdays))
            return d0 * SLOTS, (d0 + 2) * SLOTS
        m, s, e = pick_free(["office", "classroom"], ["lighting"], win)
        kw[m.meter_id][s:e] = m.rated_kw * 0.9 * rng.normal(1, 0.02, e - s)
        meter_event(m, s, e, "contextual", "Equipment schedule fault",
                    "Lighting stayed at full output all weekend in an unoccupied building.")

    # 3) Shapelet: short-cycling equipment (curve shape changes, level similar)
    for _ in range(3):
        nd = int(rng.integers(1, 4))
        def win(m):
            d0 = int(rng.choice(all_days[:-3]))
            return d0 * SLOTS, (d0 + nd) * SLOTS
        m, s, e = pick_free(None, ["misc", "AHU"], win)
        sq = (np.arange(e - s) % 2 == 0).astype(float)
        kw[m.meter_id][s:e] = m.rated_kw * (0.15 + 0.85 * sq) * rng.normal(1, 0.03, e - s)
        meter_event(m, s, e, "shapelet", "Abnormal equipment cycling",
                    f"Rapid on/off short-cycling for {nd} day(s); check thermostat, "
                    "refrigerant charge or oversized equipment.")

    # 4) Seasonal: a building's weekend looks like a weekday (weekly pattern broken)
    for b, sat in zip(rng.choice(bldgs(["office", "classroom"]), 2, replace=False),
                      rng.choice(saturdays, 2, replace=False)):
        sat, fri = int(sat), int(sat) - 1
        for mid in meters_of(b):
            for d in (sat, sat + 1):
                kw[mid][d * SLOTS:(d + 1) * SLOTS] = (normal[mid][fri * SLOTS:(fri + 1) * SLOTS]
                                                      * rng.normal(1, 0.03, SLOTS))
            busy.setdefault(mid, []).append((sat * SLOTS, (sat + 2) * SLOTS))
        add_event(start=ts[sat * SLOTS], end=ts[(sat + 2) * SLOTS - 1], scope="building",
                  zone=bzone[b], building_id=b, meter_id=None, load_type=None, lai_type="seasonal",
                  category="Unexpected consumption pattern", is_anomaly=True,
                  explanation="Whole building ran a weekday profile on Saturday and Sunday; "
                  "no event booked. Possible schedule or occupancy-sensor failure.")

    # 5) Trend: gradual degradation (e.g. clogging filter -> fan works harder)
    for k in range(3):
        fixed = k == 0  # one of them gets repaired later -> resolved
        L = int(rng.integers(14, 22)) * SLOTS
        def win(m):
            s = int(rng.integers(21, 42)) * SLOTS
            return s, (min(s + L + 7 * SLOTS, n) if fixed else n)
        m, s, e = pick_free(None, ["AHU"], win)
        ramp = np.clip(np.arange(e - s) / L, 0, 1) * rng.uniform(0.3, 0.45)
        kw[m.meter_id][s:e] *= 1 + ramp
        meter_event(m, s, e, "trend", "Equipment degradation",
                    "Load creeping up week over week under similar weather and occupancy; "
                    "consistent with filter loading or failing VFD." +
                    (" Repaired by maintenance." if fixed else ""))

    # 6) Collective at sub-grid level: many buildings in one zone deviate together
    for z in rng.choice(ZONES, 2, replace=False):
        d0 = int(rng.choice(work_days))
        s = idx(d0, 17 + int(rng.integers(0, 3)))
        e = s + int(rng.integers(12, 25))  # 3-6 hours
        f = rng.uniform(1.2, 1.3)
        for mid in mdf[mdf.building_id.map(bzone) == z].meter_id:
            kw[mid][s:e] *= f * rng.normal(1, 0.02)
        add_event(start=ts[s], end=ts[e - 1], scope="zone", zone=z, building_id=None,
                  meter_id=None, load_type=None, lai_type="collective",
                  category="Sub-grid deviation", is_anomaly=True,
                  explanation=f"All buildings in {z} rose ~{(f - 1) * 100:.0f}% together with no "
                  "weather or schedule driver; check feeder voltage / central plant.")

    # 7) Suspicious readings / data quality
    for kind in ["flatline", "flatline", "dropout", "fdi"]:
        length = {"flatline": int(rng.integers(24, 97)), "dropout": int(rng.integers(8, 49)),
                  "fdi": int(rng.integers(1, 3)) * SLOTS}[kind]
        def win(m):
            s = int(rng.choice(all_days[:-2])) * SLOTS + int(rng.integers(0, SLOTS))
            return s, s + length
        m, s, e = pick_free(None, None, win)
        x = kw[m.meter_id]
        if kind == "flatline":
            x[s:e] = x[s]
            meter_event(m, s, e, "collective", "Suspicious meter reading",
                        "Meter reported an identical value for hours (stuck sensor / comms freeze).")
        elif kind == "dropout":
            x[s:e] = np.nan
            meter_event(m, s, e, "collective", "Data quality",
                        "Missing data: meter stopped reporting.")
        else:
            x[s:e] *= 0.5
            meter_event(m, s, e, "contextual", "Suspicious meter reading",
                        "Readings abruptly halved while sibling meters were unchanged; "
                        "possible false data injection or CT/config error.")

    # 8) Happening now: faults still in progress at the most recent reading
    # a) short-cycling compressor since yesterday afternoon (shapelet)
    m, s, e = pick_free(None, ["misc"], lambda m: (idx(today - 1, 15), c_now))
    sq = (np.arange(e - s) % 2 == 0).astype(float)
    kw[m.meter_id][s:e] = m.rated_kw * (0.15 + 0.85 * sq) * rng.normal(1, 0.03, e - s)
    meter_event(m, s, e, "shapelet", "Abnormal equipment cycling",
                "Rapid on/off short-cycling started yesterday afternoon and is still going; "
                "check thermostat, refrigerant charge or a failing contactor.")
    # b) AHU schedule override: ran all weekend and is still in override (contextual)
    sat = last_dow(5, 1)
    m, s, e = pick_free(["office", "classroom"], ["AHU"], lambda m: (sat * SLOTS, c_now))
    lvl = np.nanpercentile(normal[m.meter_id][s - 7 * SLOTS:s], 85)
    kw[m.meter_id][s:e] = np.maximum(kw[m.meter_id][s:e], lvl * rng.normal(1, 0.03, e - s))
    meter_event(m, s, e, "contextual", "Equipment schedule fault",
                "AHU ran at occupied level all weekend in an empty building and the BMS override "
                "is still active.")
    # c) whole sub-grid running hot since 08:00 today (collective)
    z = ZONES[int(rng.integers(0, 4))]
    s, e = idx(today, 8), c_now
    f = rng.uniform(1.2, 1.28)
    for mid in mdf[mdf.building_id.map(bzone) == z].meter_id:
        kw[mid][s:e] *= f * rng.normal(1, 0.02)
    add_event(start=ts[s], end=ts[e - 1], scope="zone", zone=z, building_id=None, meter_id=None,
              load_type=None, lai_type="collective", category="Sub-grid deviation", is_anomaly=True,
              explanation=f"Every building in {z} has run ~{(f - 1) * 100:.0f}% above normal since "
              "08:00 with no weather or schedule driver; check feeder voltage and the central plant.")
    # d) stuck meter since early this morning (suspicious reading)
    m, s, e = pick_free(None, ["plug", "lighting"], lambda m: (idx(today, 4), c_now))
    kw[m.meter_id][s:e] = kw[m.meter_id][s]
    meter_event(m, s, e, "collective", "Suspicious meter reading",
                "Meter has reported the same value since about 04:00 (stuck sensor or comms freeze).")
    # e) demand spike in the last half hour (global)
    m, s, e = pick_free(["lab", "office"], ["AHU", "plug"], lambda m: (c_now - 2, c_now))
    kw[m.meter_id][s:e] *= rng.uniform(2.8, 3.6)
    meter_event(m, s, e, "global", "Abnormal peak demand",
                "Sudden demand spike in the last half hour, far above any reading at this time; "
                "check for a stuck damper or simultaneous equipment start.")

    # ----------------------------------------------------------------- expected baseline
    def expected(x):
        a = x.reshape(weeks, 7 * SLOTS)
        out = np.full_like(a, np.nan)
        for wk in range(1, weeks):
            out[wk] = np.nanmedian(a[max(0, wk - 4):wk], axis=0)
        return out.ravel()

    # ----------------------------------------------------------------- trim to NOW
    mids = list(mdf.meter_id)
    exp_kw = {m: expected(kw[m])[:c_now] for m in mids}
    exp_normal = {m: expected(normal[m])[:c_now] for m in mids}
    n, ts, temp = c_now, ts[:c_now], temp[:c_now]
    kw = {m: v[:c_now] for m, v in kw.items()}
    normal = {m: v[:c_now] for m, v in normal.items()}
    cut = ts[-1]
    events = [dict(e, end=min(e["end"], cut)) for e in events if e["start"] <= cut]

    # ----------------------------------------------------------------- assemble + save
    os.makedirs(out, exist_ok=True)
    long = pd.DataFrame({
        "timestamp": np.tile(ts, len(mids)),
        "meter_id": np.repeat(mids, n),
        "kw": np.concatenate([kw[m] for m in mids]).round(2),
        "kw_normal": np.concatenate([normal[m] for m in mids]).round(2),
        "expected_kw": np.concatenate([exp_kw[m] for m in mids]).round(2),
    })
    long.to_csv(f"{out}/readings.csv.gz", index=False, compression="gzip")

    meta = mdf.merge(bdf[["building_id", "zone"]], on="building_id")
    lm = long.merge(meta[["meter_id", "building_id", "zone", "load_type"]], on="meter_id")
    lm["timestamp"] = lm.timestamp.dt.floor("h")
    cols = ["kw", "kw_normal", "expected_kw"]
    # hourly average kW; min_count keeps gaps as NaN-aware sums
    bh = (lm.groupby(["timestamp", "building_id", "zone", "load_type"])[cols]
          .sum(min_count=1) / (60 / FREQ_MIN)).round(2).reset_index()
    bh.to_csv(f"{out}/building_hourly.csv", index=False)
    zh = (bh.groupby(["timestamp", "zone"])[cols].sum(min_count=1)).round(1).reset_index()
    zh.to_csv(f"{out}/zone_hourly.csv", index=False)

    # event metrics: duration, peak deviation, excess kWh, severity, status
    ev = pd.DataFrame(events)
    end_ts = ts[-1]
    rows = []
    for i, r in ev.iterrows():
        s, e = ts.get_loc(r.start), ts.get_loc(r.end) + 1
        if r.scope == "meter":
            ms = [r.meter_id]
        elif r.scope == "building":
            ms = meters_of(r.building_id)
        elif r.scope == "zone":
            ms = list(meta[meta.zone == r.zone].meter_id)
        else:
            ms = mids
        act = np.nansum([kw[m][s:e] for m in ms], axis=0)
        nor = np.sum([normal[m][s:e] for m in ms], axis=0)
        # faults: compare with the no-fault counterfactual; harmless events: with the baseline
        ref = nor if r.is_anomaly else np.nansum(
            [pd.Series(exp_normal[m][s:e]).fillna(0).values for m in ms], axis=0)
        dev = act - ref
        excess = float(np.sum(dev) * DT_H)
        pct = float(np.nanmax(np.abs(dev) / np.maximum(ref, 1e-6)))
        dur = (e - s) * DT_H
        if not r.is_anomaly:
            sev, status = "info", "explained"
        else:
            if r.category in ("Suspicious meter reading", "Data quality"):
                sev = "high" if "false data" in r.explanation else "medium"
            elif r.scope == "zone" or abs(excess) >= 1500:
                sev = "high"
            elif (pct >= 0.4 and abs(excess) >= 50) or abs(excess) >= 300:
                sev = "medium"
            else:
                sev = "low"
            age_days = (end_ts - r.end).total_seconds() / 86400
            if "Repaired" in r.explanation:
                status = "resolved"
            elif r.end >= end_ts or age_days < 4:
                status = "new"
            elif age_days < 14:
                status = rng.choice(["investigating", "new"], p=[0.7, 0.3])
            else:
                status = rng.choice(["resolved", "investigating"], p=[0.8, 0.2])
        rows.append(dict(duration_h=round(dur, 2), peak_dev_pct=round(pct * 100, 1),
                         excess_kwh=round(excess, 1), meters_affected=len(ms),
                         severity=sev, status=status,
                         active=bool(r.is_anomaly and r.end >= end_ts)))
    ev = pd.concat([ev, pd.DataFrame(rows)], axis=1).sort_values("start").reset_index(drop=True)
    ev.insert(0, "event_id", [f"EV{i + 1:03d}" for i in range(len(ev))])
    ev.to_csv(f"{out}/events.csv", index=False)

    pd.DataFrame({"zone": ZONES, "description": ["North campus sub-grid", "Central campus sub-grid",
                                                 "East campus sub-grid", "South campus sub-grid"]}
                 ).to_csv(f"{out}/zones.csv", index=False)
    bdf.to_csv(f"{out}/buildings.csv", index=False)
    mdf.to_csv(f"{out}/meters.csv", index=False)
    pd.DataFrame({"timestamp": ts, "outdoor_temp_c": temp.round(2)}).to_csv(f"{out}/weather.csv", index=False)
    pd.DataFrame({"date": dates.date,
                  "day_type": ["holiday" if hd else ("weekend" if dd.dayofweek >= 5 else "weekday")
                               for dd, hd in zip(dates, holiday_day)],
                  "note": [holidays.get(dd, "") for dd in dates]}).to_csv(f"{out}/calendar.csv", index=False)

    print(f"{len(bdf)} buildings, {len(mdf)} meters, {n} slots/meter, {len(long):,} readings")
    print(ev.groupby(["is_anomaly", "lai_type"]).size().to_string())
    print(f"Saved to {os.path.abspath(out)}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--weeks", type=int, default=10)
    p.add_argument("--now", default=NOW_DEFAULT, help="time of the most recent reading")
    p.add_argument("--out", default="sim_data")
    a = p.parse_args()
    main(a.seed, a.weeks, a.out, a.now)
