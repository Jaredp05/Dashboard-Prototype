/* Data loading, derived figures and filter state for the dashboard.
   Flat layout: every file sits next to index.html. Swap the CSV paths in DATASETS for an API later; everything else reads through `store`. */
 
const DATASETS = {
  events: 'events.csv',
  buildings: 'buildings.csv',
  zone_hourly: 'zone_hourly.csv',
  building_hourly: 'building_hourly.csv',
  building_daily: 'building_daily.csv',
  event_traces: 'event_traces.csv',
  event_overlay: 'event_overlay.csv',
};
 
// Filter defaults. "types: []" means every anomaly type.
const DEFAULTS = { zone: 'all', types: [], status: 'all', explained: true, range: '7', grain: 'hour', event: null, building: null };
 
// One fixed color per Lai anomaly type (0-5), then two spares used by the heatmap and extras.
// Okabe-Ito based, readable for common color-vision deficiencies.
const COLORS = ['#D55E00', '#0072B2', '#CC79A7', '#E69F00', '#009E73', '#8C6BB1', '#56B4E9', '#3C8DBC'];
 
// ---------- derived figures (formerly dashboard calculations)
function computeKpis(events, buildings) {
    const zones = ['all', ...new Set(buildings.map((b) => b.zone))];
    return zones.map((zone) => {
      const inZone = (r) => zone === 'all' || r.zone === zone || r.zone === 'All zones';
      const faults = events.filter((e) => String(e.is_anomaly).toLowerCase() === 'true' && inZone(e));
      const open = faults.filter((e) => e.status === 'new' || e.status === 'investigating');
      const bs = buildings.filter((b) => zone === 'all' || b.zone === zone);
      const affected = new Set();
      for (const e of open) {
        if (e.building_id) affected.add(e.building_id);
        else buildings.filter((b) => e.scope === 'campus' || b.zone === e.zone).forEach((b) => affected.add(b.building_id));
      }
      const meters = bs.reduce((s, b) => s + Number(b.meters), 0);
      const active = faults.filter((e) => String(e.active).toLowerCase() === 'true');
      const top = (active.length ? active : open).slice().sort((a, b) => Number(b.excess_kwh) - Number(a.excess_kwh))[0];
      return {
        zone,
        as_of: events.reduce((m, e) => (e.end > m ? e.end : m), ''),
        active_now: active.length,
        open_anomalies: open.length,
        high_open: open.filter((e) => e.severity === 'high').length,
        buildings_affected: affected.size,
        excess_kwh: faults.reduce((s, e) => s + Math.max(0, Number(e.excess_kwh)), 0),
        completeness_pct: Math.round(bs.reduce((s, b) => s + Number(b.completeness_pct) * Number(b.meters), 0) / meters * 100) / 100,
        top_event: top ? top.event_id : '',
        top_kwh: top ? Number(top.excess_kwh) : 0,
        top_location: top ? top.location : '',
        top_category: top ? top.category : '',
      };
    });
}
 
function computeMix(events) {
    const zones = ['all', ...new Set(events.map((e) => e.zone).filter((z) => z !== 'All zones'))];
    const out = [];
    for (const zone of zones) {
      const rows = events.filter((e) => zone === 'all' || e.zone === zone || e.zone === 'All zones');
      for (const dimension of ['lai_type', 'category']) {
        for (const key of new Set(events.map((e) => e[dimension]))) {
          const m = rows.filter((e) => e[dimension] === key);
          out.push({ zone, dimension, key, anomalies: m.filter((e) => String(e.is_anomaly).toLowerCase() === 'true').length, explained: m.filter((e) => String(e.is_anomaly).toLowerCase() !== 'true').length });
        }
      }
    }
    return out;
}
 
// ---------- store
const data = {};
const listeners = new Set();
let params = { ...DEFAULTS, ...readHash() };
let frame = 0;
 
function emit() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => { writeHash(); listeners.forEach((fn) => fn()); });
}
 
// Filters live in the URL hash so a view can be bookmarked or sent (e.g. #zone=SG-East&range=30).
function readHash() {
  const out = {};
  for (const [k, v] of new URLSearchParams(location.hash.slice(1))) {
    if (!(k in DEFAULTS)) continue;
    if (k === 'types') out.types = v ? v.split(',') : [];
    else if (k === 'explained') out.explained = v !== 'false';
    else out[k] = v || null;
  }
  return out;
}
function writeHash() {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const d = DEFAULTS[k];
    if (JSON.stringify(v) === JSON.stringify(d) || v == null) continue;
    q.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const h = q.toString();
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
}
 
export const store = {
  colors: COLORS,
  params: () => ({ ...params }),
  setParams(p) { params = { ...params, ...p }; emit(); },
  resetParams() { params = { ...DEFAULTS }; emit(); },
  /** {status: 'loading' | 'ok' | 'error', data: rows} */
  data: (id) => data[id] || { status: 'loading', data: [] },
  onData(fn) { listeners.add(fn); fn(); },
};
 
function set(id, value) { data[id] = value; emit(); }
 
async function load() {
  await Promise.all(Object.entries(DATASETS).map(async ([id, url]) => {
    try { set(id, { status: 'ok', data: await d3.csv(url) }); }
    catch (err) { console.error(`Could not load ${url}`, err); set(id, { status: 'error', data: [], message: String(err) }); }
  }));
}
 
// Derived figures recompute once their inputs have loaded.
listeners.add(() => {
  const ev = data.events, bl = data.buildings;
  if (ev?.status === 'ok' && bl?.status === 'ok' && !data.kpis) {
    data.kpis = { status: 'ok', data: computeKpis(ev.data, bl.data) };
    data.mix = { status: 'ok', data: computeMix(ev.data) };
    emit();
  }
  if ((ev?.status === 'error' || bl?.status === 'error') && !data.kpis) data.kpis = data.mix = { status: 'error', data: [] };
});
 
window.addEventListener('resize', () => emit());
load();
 
