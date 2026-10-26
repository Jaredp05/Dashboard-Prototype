/* DERConnect anomaly operations dashboard: drawing and interaction.
   Data and filter state come from store.js; d3 v7 is loaded globally in index.html. */
import { store } from './store.js';

const LAI = [
  { key: 'global', label: 'Global', note: 'A single reading far outside the normal range.' },
  { key: 'contextual', label: 'Contextual', note: 'A normal value at the wrong time, such as daytime load at night.' },
  { key: 'collective', label: 'Collective', note: 'A run of readings that is abnormal together, though no single one is extreme.' },
  { key: 'shapelet', label: 'Shapelet', note: 'The load curve has the wrong shape, such as rapid on/off cycling.' },
  { key: 'seasonal', label: 'Seasonal', note: 'The daily or weekly rhythm broke, such as a weekend that looks like a weekday.' },
  { key: 'trend', label: 'Trend', note: 'A slow drift away from the baseline over days or weeks.' },
];
const RULE_OUT = {
  global: ['Equipment start-up after a planned outage', 'Testing or commissioning on a work order'],
  contextual: ['A booked evening or weekend event', 'A holiday or break schedule', 'An occupant-requested override'],
  collective: ['Unusual weather across campus', 'Central plant or utility switching', 'A meter network outage'],
  shapelet: ['HVAC changeover between heating and cooling', 'Recent controls tuning'],
  seasonal: ['Exam week or a special schedule', 'A building schedule change by facilities'],
  trend: ['New equipment or occupants (legitimate growth)', 'Warmer weather over the period'],
  data: ['Meter maintenance or a current-transformer swap', 'A network outage at the building'],
};
const SEV = { high: 3, medium: 2, low: 1, info: 0 };
const SEV_COLOR = { high: 'var(--color-bad)', medium: 'var(--color-warn)', low: 'var(--color-fg-muted)', info: 'var(--cds-chart-muted)' };
const isActive = (e) => String(e.active).toLowerCase() === 'true';
const STATUS_COLOR = { new: 'var(--color-bad)', investigating: 'var(--color-warn)', resolved: 'var(--color-ok)', explained: 'var(--color-fg-muted)' };
const MUTED = 'var(--cds-chart-muted)';
const FG = 'var(--color-fg)';
const REF = 'var(--cds-chart-reference)';
const laiIndex = (k) => LAI.findIndex((l) => l.key === k);
const laiColor = (k) => (laiIndex(k) < 0 ? MUTED : store.colors[laiIndex(k)]);
const evColor = (e) => (e.anomaly ? laiColor(e.lai_type) : MUTED);
const laiLabel = (k) => (LAI.find((l) => l.key === k) || { label: k }).label;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

const fmtInt = d3.format(',');
const compactF = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const compact = (v) => (Math.abs(v) >= 10000 ? compactF.format(v) : fmtInt(Math.round(v)));
const fDate = d3.utcFormat('%b %-d');
const fDT = d3.utcFormat('%a %b %-d, %H:%M');
const fDay = d3.utcFormat('%a %b %-d');
const fWeek = d3.utcFormat('Week of %b %-d');
const fHM = d3.utcFormat('%H:%M');
const fDur = (h) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${+h.toFixed(1)} h` : `${+(h / 24).toFixed(1)} days`);
const num = (v) => (v === '' || v == null || v === 'NaN' ? null : Number(v));
const parseTs = (s) => new Date(`${s}:00Z`);
const parseDay = (s) => new Date(`${s}T00:00:00Z`);

const cache = new Map();
function get(id, parse) {
  const d = store.data(id);
  if (d.status !== 'ok' || !Array.isArray(d.data)) return null;
  const c = cache.get(id);
  if (c && c.raw === d.data) return c.rows;
  const rows = parse ? d.data.map(parse) : d.data;
  cache.set(id, { raw: d.data, rows });
  return rows;
}
const failed = (...ids) => ids.some((id) => ['error', 'connect', 'declined'].includes(store.data(id).status));
function waiting(box, ...ids) {
  if (failed(...ids)) { box.classList.remove('skeleton'); box.replaceChildren(el('div', 'ops-failed', 'Failed to load')); }
  return true;
}

const events = () => get('events', (r) => ({
  ...r, anomaly: String(r.is_anomaly).toLowerCase() === 'true', startD: parseTs(r.start), endD: parseTs(r.end),
  duration_h: Number(r.duration_h), peak_dev_pct: Number(r.peak_dev_pct), excess_kwh: Number(r.excess_kwh), meters_affected: Number(r.meters_affected),
}));
const buildings = () => get('buildings', (r) => ({ ...r, sqft: Number(r.sqft), meters: Number(r.meters), completeness_pct: Number(r.completeness_pct) }));
const zoneHourly = () => get('zone_hourly', (r) => ({ t: parseTs(r.ts), zone: r.zone, kw: num(r.kw), exp: num(r.expected_kw), temp: num(r.temp_c) }));
const bHourly = () => get('building_hourly', (r) => ({ t: parseTs(r.ts), b: r.building_id, kw: num(r.kw), exp: num(r.expected_kw), trend: num(r.trend_kw), season: num(r.seasonal_kw), resid: num(r.residual_kw) }));
const bDaily = () => get('building_daily', (r) => ({ t: parseDay(r.date), date: r.date, b: r.building_id, kwh: num(r.kwh), exp: num(r.expected_kwh), dev: num(r.dev_pct), AHU: num(r.ahu_kwh), Lighting: num(r.lighting_kwh), Plug: num(r.plug_kwh), Misc: num(r.misc_kwh) }));

// ---------- filters
const P = () => {
  const p = store.params();
  return { zone: p.zone || 'all', types: Array.isArray(p.types) ? p.types : [], status: p.status || 'all', explained: p.explained !== false, range: p.range || 'all', grain: p.grain || 'hour', event: p.event || null, building: p.building || null };
};
const inZone = (e, zone) => zone === 'all' || e.zone === zone || e.zone === 'All zones';
function passes(e, p) {
  if (!inZone(e, p.zone)) return false;
  if (!e.anomaly && !p.explained) return false;
  if (p.types.length && !p.types.includes(e.lai_type)) return false;
  if (p.status === 'active' && !(e.anomaly && isActive(e))) return false;
  if (p.status === 'open' && !(e.status === 'new' || e.status === 'investigating')) return false;
  if (p.status === 'resolved' && e.status !== 'resolved') return false;
  return true;
}
function toggleType(k) {
  const cur = P().types;
  let next;
  if (!cur.length) next = [k];
  else if (cur.includes(k)) next = cur.filter((t) => t !== k);
  else next = [...cur, k];
  if (next.length === LAI.length) next = [];
  store.setParams({ types: next });
}
const chipBox = $('#f-types');
for (const l of LAI) {
  const b = el('button', 'ops-chip'); b.type = 'button'; b.dataset.k = l.key;
  const sw = el('i', 'ops-sw'); sw.style.background = laiColor(l.key);
  b.append(sw, document.createTextNode(l.label));
  b.addEventListener('click', () => toggleType(l.key));
  chipBox.append(b);
}
$('#f-zone').addEventListener('change', (ev) => store.setParams({ zone: ev.target.value }));
$('#f-building').addEventListener('change', (ev) => store.setParams({ building: ev.target.value }));
for (const [id, name] of [['#f-status', 'status'], ['#f-range', 'range'], ['#f-grain', 'grain']]) {
  $(id).addEventListener('click', (ev) => { const b = ev.target.closest('button[data-v]'); if (b) store.setParams({ [name]: b.dataset.v }); });
}
$('#f-explained').addEventListener('change', (ev) => store.setParams({ explained: ev.target.checked }));
$('#f-reset').addEventListener('click', () => store.resetParams());
function drawFilters(p, bl) {
  const zsel = $('#f-zone');
  if (bl && zsel.options.length === 1) for (const z of [...new Set(bl.map((b) => b.zone))].sort()) zsel.append(new Option(z, z));
  zsel.value = p.zone;
  for (const b of chipBox.children) b.setAttribute('aria-pressed', String(!p.types.length || p.types.includes(b.dataset.k)));
  for (const [id, v] of [['#f-status', p.status], ['#f-range', p.range], ['#f-grain', p.grain]]) for (const b of $(id).children) b.setAttribute('aria-pressed', String(b.dataset.v === v));
  $('#f-explained').checked = p.explained;
}
function selectEvent(e, scroll) {
  store.setParams({ event: e.event_id, building: e.building_id || P().building });
  if (scroll) document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- time helpers
function rangeOf(p, maxT) {
  const end = +maxT + 3600000;
  return p.range === 'all' ? null : [new Date(end - Number(p.range) * 86400000), new Date(end)];
}
function bucket(points, grain, keys) {
  if (grain === 'hour') return points;
  const iv = grain === 'day' ? d3.utcDay : d3.utcMonday;
  return d3.rollups(points, (v) => Object.fromEntries(keys.map((k) => [k, d3.mean(v, (p) => p[k])])), (p) => +iv.floor(p.t))
    .map(([t, v]) => ({ t: new Date(t), ...v })).sort((a, b) => a.t - b.t);
}
const tipFmt = (grain) => (grain === 'day' ? fDay : grain === 'week' ? fWeek : fDT);
function autoFmt(dom) {
  const span = dom[1] - dom[0];
  if (span <= 2.5 * 86400000) return (d) => (d.getUTCHours() === 0 ? fDate(d) : fHM(d));
  return fDate;
}

// ---------- generic line chart
function lineChart(box, o) {
  box.classList.remove('skeleton');
  box.replaceChildren();
  const W = Math.max(260, box.clientWidth || 600), H = o.height;
  const pts = o.series.flatMap((s) => s.points).filter((p) => p.y != null && Number.isFinite(p.y));
  if (!pts.length) { box.append(el('p', 'ops-empty', o.empty || 'No readings in this range.')); return; }
  const xDom = o.xDomain || d3.extent(o.series.flatMap((s) => s.points.map((p) => p.x)));
  let [y0, y1] = d3.extent(pts, (p) => p.y);
  if (o.symmetric) { const m = Math.max(Math.abs(y0), Math.abs(y1)) || 1; y0 = -m; y1 = m; }
  else if (o.yZero !== false && y0 > 0) y0 = 0;
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const bottom = H - 22;
  const y = d3.scaleLinear([y0, y1], [bottom, 8]).nice(Math.max(2, Math.floor(H / 45)));
  const svg = d3.select(box).append('svg').attr('class', 'ops-svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', o.label || 'Chart');
  const yFmt = o.yFmt || compact;
  const ticks = y.ticks(Math.max(2, Math.floor(H / 45)));
  const gy = svg.append('g').attr('class', 'ops-axis');
  const yl = gy.selectAll('text').data(ticks).join('text').attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(yFmt);
  let lw = 0; yl.each(function () { lw = Math.max(lw, this.getComputedTextLength()); });
  const ml = Math.ceil(lw) + 10, mr = o.mr ?? 10;
  yl.attr('x', ml - 8);
  const x = (o.xType === 'linear' ? (o.xLog ? d3.scaleLog() : d3.scaleLinear()) : d3.scaleUtc()).domain(xDom).range([ml, W - mr]);
  svg.insert('g', ':first-child').selectAll('line').data(ticks).join('line').attr('class', (d) => (d === 0 && y0 < 0 ? 'ops-zero' : 'ops-grid'))
    .attr('x1', ml).attr('x2', W - mr).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  const gb = svg.append('g');
  for (const b of o.bands || []) {
    const a = Math.max(ml, x(b.x0)), z = Math.min(W - mr, x(b.x1));
    if (z < ml || a > W - mr) continue;
    gb.append('rect').attr('x', a).attr('y', 8).attr('width', Math.max(3, z - a)).attr('height', bottom - 8).style('fill', b.color).attr('fill-opacity', b.opacity ?? 0.16);
  }
  svg.append('line').attr('class', 'ops-axisline').attr('x1', ml).attr('x2', W - mr).attr('y1', bottom).attr('y2', bottom);
  const xf = o.xFmt || autoFmt(xDom);
  let xt = o.xTicks;
  if (!xt) {
    const nT = Math.max(2, Math.floor((W - ml) / 85));
    const spanDays = o.xType === 'linear' ? 0 : (xDom[1] - xDom[0]) / 864e5;
    // one label per day (or every few days) once the chart spans several days, so dates never repeat
    xt = spanDays > 2.5 ? x.ticks(d3.utcDay.every(Math.max(1, Math.ceil(spanDays / nT)))) : x.ticks(nT);
  }
  const gx = svg.append('g').attr('class', 'ops-axis');
  let lastR = -Infinity;
  gx.selectAll('text').data(xt).join('text').attr('x', (d) => x(d)).attr('y', H - 4).attr('text-anchor', 'middle').text(xf)
    .each(function (d) {
      const w = this.getComputedTextLength(), cx = x(d);
      if (cx - w / 2 < 0 || cx + w / 2 > W || cx - w / 2 < lastR + 8) this.remove(); else lastR = cx + w / 2;
    });
  const line = d3.line().defined((p) => p.y != null && Number.isFinite(p.y)).x((p) => x(p.x)).y((p) => y(p.y));
  for (const s of o.series) {
    svg.append('path').attr('d', line(s.points)).attr('fill', 'none').style('stroke', s.color).attr('stroke-width', s.width || 2)
      .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('stroke-dasharray', s.dash || null).attr('stroke-opacity', s.opacity ?? 1);
  }
  if (o.now && o.now >= xDom[0] && o.now <= xDom[1]) {
    const nx = x(o.now);
    svg.append('line').attr('class', 'ops-nowline').attr('x1', nx).attr('x2', nx).attr('y1', 8).attr('y2', bottom);
    const lab = svg.append('text').attr('class', 'ops-nowlabel').attr('y', 14).attr('text-anchor', 'end').attr('x', nx - 4).text('Now');
    if (nx - 4 - lab.node().getComputedTextLength() < ml) lab.attr('text-anchor', 'start').attr('x', nx + 4);
  }
  for (const d of o.dots || []) svg.append('circle').attr('cx', x(d.x)).attr('cy', y(d.y)).attr('r', d.r || 5).style('fill', d.color).style('stroke', 'var(--color-panel)').attr('stroke-width', 2);

  const tip = el('div', 'ops-tip'); tip.hidden = true; box.append(tip);
  const rule = svg.append('line').attr('class', 'ops-rule').attr('y1', 8).attr('y2', bottom).attr('visibility', 'hidden');
  const hov = svg.append('g');
  const ov = svg.append('rect').attr('x', ml).attr('y', 0).attr('width', Math.max(1, W - mr - ml)).attr('height', bottom).attr('fill', 'transparent');
  const bandAt = (xv) => (o.bands || []).find((b) => xv >= b.x0 && xv <= b.x1);
  ov.on('pointermove', (ev) => {
    const [mx] = d3.pointer(ev, svg.node());
    const xv = x.invert(mx);
    const rows = o.series.filter((s) => !s.noTip && s.points.length).map((s) => ({ s, p: s.points[d3.bisector((p) => p.x).center(s.points, xv)] }));
    if (!rows.length) return;
    const px = x(rows[0].p.x);
    rule.attr('x1', px).attr('x2', px).attr('visibility', 'visible');
    hov.selectAll('circle').data(rows.filter((r) => r.p.y != null)).join('circle').attr('cx', (r) => x(r.p.x)).attr('cy', (r) => y(r.p.y)).attr('r', 3.5).style('fill', (r) => r.s.color);
    tip.replaceChildren(el('div', 'ops-tip-h', (o.tipX || xf)(rows[0].p.x)));
    for (const r of rows) {
      const row = el('div', 'ops-tip-row');
      const sw = el('i', 'ops-sw'); sw.style.background = r.s.color;
      row.append(...(rows.length > 1 ? [sw] : []), el('span', null, r.s.name), el('b', null, r.p.y == null ? 'No data' : (o.tipY || yFmt)(r.p.y)));
      tip.append(row);
    }
    const b = bandAt(xv);
    if (b && b.label) tip.append(el('div', 'ops-tip-note', b.label));
    ov.style('cursor', b && o.onBand ? 'pointer' : 'default');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = px + 14; if (left + tw > W) left = px - tw - 14;
    tip.style.left = `${Math.max(0, left)}px`; tip.style.top = '6px';
  }).on('pointerleave', () => { tip.hidden = true; rule.attr('visibility', 'hidden'); hov.selectAll('*').remove(); });
  if (o.onBand) ov.on('click', (ev) => { const [mx] = d3.pointer(ev, svg.node()); const b = bandAt(x.invert(mx)); if (b) o.onBand(b); });
  if (o.rug && o.rug.length) {
    const gr = svg.append('g');
    for (const r of o.rug) {
      const a = Math.max(ml, x(r.x0)), z = Math.min(W - mr, x(r.x1));
      if (z < ml || a > W - mr) continue;
      gr.append('rect').attr('x', a - 1).attr('y', bottom - 9).attr('width', Math.max(3, z - a + 2)).attr('height', 7).attr('rx', 2).style('fill', r.color)
        .attr('fill-opacity', r.selected ? 1 : 0.85).style('stroke', r.selected ? FG : 'none').style('cursor', 'pointer')
        .on('click', () => o.onRug(r))
        .on('pointerenter', () => { tip.replaceChildren(el('div', 'ops-tip-h', r.title), el('div', null, r.label)); tip.hidden = false; tip.style.left = `${Math.min(Math.max(0, a - 40), W - 200)}px`; tip.style.top = `${bottom - 70}px`; })
        .on('pointerleave', () => { tip.hidden = true; });
    }
  }
}

// ---------- header + KPIs
function drawHeader(p) {
  const k = get('kpis');
  const box = $('#takeaway');
  if (!k) { if (failed('events', 'buildings')) box.replaceChildren(el('span', 'ops-failed', 'Failed to load')); return; }
  const r = k.find((x) => x.zone === p.zone) || k[0];
  for (const n of document.querySelectorAll('#kpis [data-field]')) {
    n.classList.remove('skeleton');
    const v = r[n.dataset.field];
    n.textContent = n.dataset.field === 'completeness_pct' ? v.toFixed(2) : fmtInt(v);
  }
  $('#kpi-high').classList.toggle('is-alert', r.high_open > 0);
  $('#kpi-active').classList.toggle('is-alert', r.active_now > 0);
  $('#period-note').textContent = `Latest reading ${fDT(parseTs(r.as_of))}. Simulated campus data: 24 buildings and 236 submeters in four sub-grids, 15-minute readings. Not real DERConnect measurements.`;
  const zl = r.zone === 'all' ? 'all four sub-grids' : r.zone;
  const m = (field, text) => { const s = el('b', null, text); return s; };
  const t = document.createTextNode.bind(document);
  if (!r.open_anomalies) { box.replaceChildren(t(`No anomalies are open in ${zl}.`)); return; }
  const lead = r.active_now
    ? [m('active_now', fmtInt(r.active_now)), t(` anomalies are in progress right now across ${zl}, out of `), m('open_anomalies', fmtInt(r.open_anomalies)), t(' open. The costliest live one is ')]
    : [t(`Nothing is in progress right now in ${zl}, but `), m('open_anomalies', fmtInt(r.open_anomalies)), t(' anomalies are still open. The costliest is ')];
  box.replaceChildren(...lead,
    m('top_event', r.top_event), t(', '), m('top_category', r.top_category.toLowerCase()), t(' at '), m('top_location', r.top_location), t(', at about '), m('top_kwh', fmtInt(r.top_kwh)), t(' kWh of excess energy so far.'),
  );
}

// ---------- happening now
function drawNow(p, ev) {
  const box = $('#now-list');
  if (!ev) { waiting(box, 'events'); return; }
  box.classList.remove('skeleton');
  const live = ev.filter((e) => e.anomaly && isActive(e) && inZone(e, p.zone) && (!p.types.length || p.types.includes(e.lai_type)))
    .sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.startD - a.startD);
  $('#now-sub').textContent = live.length ? 'Faults still in progress at the latest reading, most severe first. Click one for details.' : 'Nothing is in progress at the latest reading for these filters.';
  box.replaceChildren(...live.map((e) => {
    const mk = (tag, field, text, cls) => { const n = el(tag, cls, text); return n; };
    const card = el('button', 'ops-now-card'); card.type = 'button'; card.setAttribute('aria-pressed', String(e.event_id === p.event));
    const top = el('div', 'ops-now-top');
    const pu = el('i', 'ops-pulse'); pu.style.setProperty('--c', laiColor(e.lai_type));
    const lai = el('span', 'ops-lai'); lai.append(mk('span', 'lai_type', e.lai_type));
    const sev = mk('span', 'severity', e.severity, 'ops-sev'); sev.style.setProperty('--sev', SEV_COLOR[e.severity]);
    top.append(pu, mk('b', 'event_id', e.event_id), lai, sev);
    const meta = el('div', 'ops-now-meta');
    meta.append(document.createTextNode(`Since ${fDT(e.startD)} · `), mk('b', 'duration_h', fmtInt(e.duration_h)), document.createTextNode(' h so far · '), mk('b', 'excess_kwh', fmtInt(e.excess_kwh)), document.createTextNode(' kWh excess'));
    card.append(top, mk('div', 'category', e.category, 'ops-now-cat'), mk('div', 'location', e.location, 'ops-now-loc'), meta);
    card.addEventListener('click', () => selectEvent(e, true));
    return card;
  }));
}

// ---------- sub-grid chart
let campusCache = null;
function drawSubgrid(p, ev) {
  const box = $('#subgrid-chart'), tbox = $('#temp-chart');
  const zh = zoneHourly();
  if (!zh || !ev) { waiting(box, 'zone_hourly', 'events'); waiting(tbox, 'zone_hourly'); return; }
  let pts;
  if (p.zone === 'all') {
    if (!campusCache || campusCache.raw !== zh) {
      const sum = (v, k) => (v.some((r) => r[k] != null) ? d3.sum(v, (r) => r[k]) : null);
      campusCache = { raw: zh, rows: d3.rollups(zh, (v) => ({ kw: sum(v, 'kw'), exp: sum(v, 'exp'), temp: v[0].temp }), (r) => +r.t).map(([t, v]) => ({ t: new Date(t), ...v })).sort((a, b) => a.t - b.t) };
    }
    pts = campusCache.rows;
  } else pts = zh.filter((r) => r.zone === p.zone);
  const maxT = pts[pts.length - 1].t;
  const rg = rangeOf(p, maxT);
  if (rg) pts = pts.filter((r) => r.t >= rg[0] && r.t < rg[1]);
  const b = bucket(pts, p.grain, ['kw', 'exp', 'temp']);
  const dom = rg || d3.extent(b, (r) => r.t);
  $('#subgrid-title').textContent = p.zone === 'all' ? 'Campus load vs expected' : `${p.zone} load vs expected`;
  const shown = ev.filter((e) => passes(e, p));
  const bands = shown.filter((e) => e.scope === 'zone' || e.scope === 'campus').map((e) => ({ x0: e.startD, x1: new Date(+e.endD + 900000), color: evColor(e), opacity: e.anomaly ? 0.22 : 0.14, label: `${e.event_id} · ${e.category}${e.anomaly ? '' : ' (explained)'}`, e }));
  const rug = shown.filter((e) => e.scope === 'meter' || e.scope === 'building').map((e) => ({ x0: e.startD, x1: new Date(+e.endD + 900000), color: evColor(e), e, selected: e.event_id === p.event, title: `${e.event_id} · ${laiLabel(e.lai_type)}`, label: `${e.category} at ${e.location}` }));
  lineChart(box, {
    height: 260, label: 'Sub-grid load vs expected', xDomain: dom, tipX: tipFmt(p.grain), tipY: (v) => `${fmtInt(Math.round(v))} kW`,
    series: [{ name: 'Expected', color: REF, width: 1.5, dash: '5 4', points: b.map((r) => ({ x: r.t, y: r.exp })) }, { name: 'Measured', color: FG, width: p.grain === 'hour' ? 1.25 : 2, points: b.map((r) => ({ x: r.t, y: r.kw })) }],
    bands, onBand: (bd) => selectEvent(bd.e, true), rug, onRug: (r) => selectEvent(r.e, true), now: maxT,
  });
  lineChart(tbox, { height: 90, label: 'Outdoor temperature', xDomain: dom, yZero: false, tipX: tipFmt(p.grain), yFmt: (v) => `${v}°`, tipY: (v) => `${v.toFixed(1)} °C`, series: [{ name: 'Outdoor temperature', color: 'var(--color-fg-muted)', width: 1.5, points: b.map((r) => ({ x: r.t, y: r.temp })) }] });
  const key = $('#subgrid-key');
  key.replaceChildren();
  if (bands.some((x) => !x.e.anomaly)) { const s = el('span'); const k = el('i', 'ops-key-band'); k.style.background = MUTED; s.append(k, document.createTextNode('Explained event')); key.append(s); }
}

// ---------- heatmap
function drawHeatmap(p, ev, bl) {
  const box = $('#heatmap-chart');
  const bd = bDaily();
  if (!bd || !ev || !bl) { waiting(box, 'building_daily', 'buildings', 'events'); return; }
  box.classList.remove('skeleton'); box.replaceChildren();
  const maxT = d3.max(bd, (r) => r.t);
  const rg = rangeOf(p, new Date(+maxT + 23 * 3600000));
  const rows = bl.filter((b) => p.zone === 'all' || b.zone === p.zone).sort((a, b) => d3.ascending(a.zone, b.zone) || d3.ascending(a.building_id, b.building_id));
  const days = [...new Set(bd.filter((r) => !rg || (r.t >= d3.utcDay.floor(rg[0]) && r.t < rg[1])).map((r) => +r.t))].sort((a, b) => a - b).map((t) => new Date(t));
  const byKey = new Map(bd.map((r) => [`${r.b}|${+r.t}`, r]));
  const W = Math.max(260, box.clientWidth || 600), ch = 15, top = 4, bottom = 22;
  const H = top + rows.length * ch + bottom;
  const svg = d3.select(box).append('svg').attr('class', 'ops-svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Buildings by day heatmap');
  const gl = svg.append('g').attr('class', 'ops-axis');
  const names = gl.selectAll('text').data(rows).join('text').attr('y', (d, i) => top + i * ch + ch / 2).attr('dy', '0.32em').attr('text-anchor', 'end')
    .text((d) => `${d.name} · ${d.zone.replace('SG-', '')}`).style('font-weight', (d) => (d.building_id === p.building ? 'var(--cds-font-weight-medium)' : null)).style('fill', (d) => (d.building_id === p.building ? FG : null));
  let lw = 0; names.each(function () { lw = Math.max(lw, this.getComputedTextLength()); });
  const ml = Math.ceil(lw) + 10;
  names.attr('x', ml - 6);
  const x = d3.scaleBand(days.map((d) => +d), [ml, W - 4]).paddingInner(0.08);
  const cells = [];
  rows.forEach((b, i) => days.forEach((d) => { const r = byKey.get(`${b.building_id}|${+d}`); if (r) cells.push({ r, i, b }); }));
  svg.append('g').selectAll('rect').data(cells).join('rect')
    .attr('x', (c) => x(+c.r.t)).attr('y', (c) => top + c.i * ch + 1).attr('width', x.bandwidth()).attr('height', ch - 2).attr('rx', 2)
    .style('fill', (c) => (c.r.dev == null ? 'transparent' : c.r.dev >= 0 ? 'var(--cds-chart-status-critical)' : store.colors[7]))
    .attr('fill-opacity', (c) => (c.r.dev == null ? 0 : Math.min(0.95, 0.07 + Math.abs(c.r.dev) / 45)));
  const sel = rows.findIndex((b) => b.building_id === p.building);
  if (sel >= 0) svg.append('rect').attr('x', ml - 2).attr('y', top + sel * ch).attr('width', W - 4 - ml + 4).attr('height', ch).attr('rx', 3).style('fill', 'none').style('stroke', FG).attr('stroke-width', 1);
  const dots = [];
  for (const e of ev.filter((e) => e.anomaly && e.building_id && passes(e, p))) {
    const i = rows.findIndex((b) => b.building_id === e.building_id); if (i < 0) continue;
    for (const d of d3.utcDay.range(d3.utcDay.floor(e.startD), new Date(+e.endD + 1))) if (x(+d) != null) dots.push({ x: x(+d) + x.bandwidth() / 2, y: top + i * ch + ch / 2, e });
  }
  const dd = d3.groups(dots, (d) => `${d.x}|${d.y}`).map(([, v]) => v[0]);
  svg.append('g').selectAll('circle').data(dd).join('circle').attr('cx', (d) => d.x).attr('cy', (d) => d.y).attr('r', Math.min(2.6, x.bandwidth() / 2.5)).style('fill', FG).attr('pointer-events', 'none');
  const gx = svg.append('g').attr('class', 'ops-axis');
  let lastR = -Infinity;
  gx.selectAll('text').data(days.filter((d) => d.getUTCDay() === 1 || days.length <= 10)).join('text').attr('x', (d) => x(+d) + x.bandwidth() / 2).attr('y', H - 5).attr('text-anchor', 'middle').text(fDate)
    .each(function (d) { const w = this.getComputedTextLength(), cx = x(+d) + x.bandwidth() / 2; if (cx - w / 2 < ml - 4 || cx + w / 2 > W || cx - w / 2 < lastR + 8) this.remove(); else lastR = cx + w / 2; });
  const tip = el('div', 'ops-tip'); tip.hidden = true; box.append(tip);
  const hit = svg.append('rect').attr('x', ml).attr('y', top).attr('width', W - 4 - ml).attr('height', rows.length * ch).attr('fill', 'transparent').style('cursor', 'pointer');
  const at = (ev2) => {
    const [mx, my] = d3.pointer(ev2, svg.node());
    const i = Math.floor((my - top) / ch); const di = Math.floor((mx - ml) / x.step());
    if (i < 0 || i >= rows.length || di < 0 || di >= days.length) return null;
    return { b: rows[i], r: byKey.get(`${rows[i].building_id}|${+days[di]}`), mx, my };
  };
  hit.on('pointermove', (e2) => {
    const a = at(e2); if (!a || !a.r) { tip.hidden = true; return; }
    const evs = ev.filter((e) => e.anomaly && e.building_id === a.b.building_id && passes(e, p) && e.startD < new Date(+a.r.t + 86400000) && e.endD >= a.r.t);
    tip.replaceChildren(el('div', 'ops-tip-h', `${fDay(a.r.t)} · ${a.b.name}`));
    const add = (n, v) => { const row = el('div', 'ops-tip-row'); row.append(el('span', null, n), el('b', null, v)); tip.append(row); };
    add('Energy', a.r.kwh == null ? 'No data' : `${fmtInt(a.r.kwh)} kWh`);
    add('Expected', a.r.exp == null ? 'No baseline yet' : `${fmtInt(a.r.exp)} kWh`);
    if (a.r.dev != null) add('Difference', `${a.r.dev > 0 ? '+' : ''}${a.r.dev.toFixed(1)}%`);
    for (const e of evs) tip.append(el('div', 'ops-tip-note', `${e.event_id} · ${e.category}`));
    tip.hidden = false;
    const tw = tip.offsetWidth; let left = a.mx + 14; if (left + tw > W) left = a.mx - tw - 14;
    tip.style.left = `${Math.max(0, left)}px`; tip.style.top = `${Math.max(0, Math.min(a.my - 20, H - tip.offsetHeight))}px`;
  }).on('pointerleave', () => { tip.hidden = true; })
    .on('click', (e2) => { const a = at(e2); if (a) { store.setParams({ building: a.b.building_id }); document.getElementById('building').scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
  const key = $('#heatmap-key'); key.replaceChildren();
  const sw = (color, op, text) => { const s = el('span'); const k = el('i', 'ops-sw'); k.style.background = color; k.style.opacity = op; s.append(k, document.createTextNode(text)); return s; };
  key.append(sw(store.colors[7], 0.75, '30% below expected'), sw(store.colors[7], 0.25, '10% below'), sw('var(--cds-chart-status-critical)', 0.25, '10% above'), sw('var(--cds-chart-status-critical)', 0.75, '30% above'));
  const s = el('span'); const k = el('i', 'ops-key-dot'); k.style.background = FG; k.style.width = '6px'; k.style.height = '6px'; s.append(k, document.createTextNode('Fault event that day')); key.append(s);
  const n = el('span', null, 'Blank: first week, before a baseline exists'); key.append(n);
}

// ---------- mix
function drawMix(p) {
  const mix = get('mix');
  const tBox = $('#mix-types'), cBox = $('#mix-cats');
  if (!mix) { if (failed('events')) tBox.replaceChildren(el('div', 'ops-failed', 'Failed to load')); return; }
  const rows = mix.filter((r) => r.zone === p.zone);
  const max = d3.max(rows, (r) => r.anomalies + (p.explained ? r.explained : 0)) || 1;
  const bar = (r, color, onClick, pressed) => {
    const row = el(onClick ? 'button' : 'div', 'ops-mix-row');
    if (onClick) { row.type = 'button'; row.addEventListener('click', onClick); row.setAttribute('aria-pressed', String(pressed)); }
    const name = el('span', 'ops-mix-name');
    if (color) { const s = el('i', 'ops-sw'); s.style.background = color; name.append(s); }
    name.append(document.createTextNode(r.label));
    const track = el('span', 'ops-mix-track');
    const a = el('i'); a.style.width = `${(100 * r.anomalies) / max}%`; a.style.background = color || 'var(--color-fg-muted)';
    const b = el('i'); b.style.width = `${(100 * (p.explained ? r.explained : 0)) / max}%`; b.style.background = color || 'var(--color-fg-muted)'; b.style.opacity = '.3';
    track.append(a, b);
    const n = el('span', 'ops-mix-n'); n.append(el('b', null, fmtInt(r.anomalies)));
    if (p.explained && r.explained) n.append(document.createTextNode(` + ${r.explained}`));
    row.append(name, track, n);
    return row;
  };
  tBox.replaceChildren(...LAI.map((l) => {
    const r = rows.find((x) => x.dimension === 'lai_type' && x.key === l.key) || { anomalies: 0, explained: 0 };
    return bar({ ...r, label: l.label }, laiColor(l.key), () => toggleType(l.key), !p.types.length || p.types.includes(l.key));
  }));
  cBox.replaceChildren(...rows.filter((r) => r.dimension === 'category' && (r.anomalies || (p.explained && r.explained)))
    .sort((a, b) => b.anomalies - a.anomalies || b.explained - a.explained).map((r) => bar({ ...r, label: r.key }, null)));
}

// ---------- table
let sortK = 'priority', sortDir = -1;
const tbl = $('#ev-table');
for (const btn of tbl.querySelectorAll('th button')) btn.addEventListener('click', () => { const k = btn.dataset.k; if (sortK === k) sortDir = -sortDir; else { sortK = k; sortDir = ['duration_h', 'peak_dev_pct', 'excess_kwh', 'severity', 'start'].includes(k) ? -1 : 1; } drawAll(); });
$('#ev-search').addEventListener('input', () => drawAll());
tbl.addEventListener('click', (e2) => { const tr = e2.target.closest('tr[data-key]'); if (tr) { const e = (events() || []).find((x) => x.event_id === tr.dataset.key); if (e) selectEvent(e, false); } });
tbl.addEventListener('keydown', (e2) => { if (e2.key !== 'Enter' && e2.key !== ' ') return; const tr = e2.target.closest('tr[data-key]'); if (tr) { e2.preventDefault(); tr.click(); } });
function sortedVisible(ev, p) {
  const q = $('#ev-search').value.trim().toLowerCase();
  const vis = ev.filter((e) => passes(e, p) && (!q || [e.event_id, e.category, e.location, e.lai_type, e.status, e.severity, e.explanation].join(' ').toLowerCase().includes(q)));
  const val = (e) => (sortK === 'priority' ? [Number(e.anomaly && isActive(e)), Number(e.status === 'new' || e.status === 'investigating'), SEV[e.severity], e.excess_kwh] : sortK === 'severity' ? [SEV[e.severity], e.excess_kwh] : [e[sortK]]);
  return vis.sort((a, b) => { const va = val(a), vb = val(b); for (let i = 0; i < va.length; i++) { const c = d3.ascending(va[i], vb[i]); if (c) return c * sortDir; } return 0; });
}
function drawTable(p, ev) {
  const body = tbl.tBodies[0];
  if (!ev) { if (failed('events')) body.replaceChildren(); return null; }
  const vis = sortedVisible(ev, p);
  for (const th of tbl.querySelectorAll('th')) th.setAttribute('aria-sort', th.dataset.field === sortK ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
  const selId = p.event && vis.some((e) => e.event_id === p.event) ? p.event : vis[0] && vis[0].event_id;
  body.replaceChildren(...vis.map((e) => {
    const tr = el('tr', e.anomaly ? '' : 'is-explained'); tr.dataset.key = e.event_id; tr.tabIndex = 0; tr.setAttribute('aria-selected', String(e.event_id === selId));
    const td = (cls, ...kids) => { const c = el('td', cls); c.append(...kids); return c; };
    const sev = el('span', 'ops-sev', e.severity); sev.style.setProperty('--sev', SEV_COLOR[e.severity]);
    const st = el('span', 'ops-pill', e.status); st.style.setProperty('--pill', STATUS_COLOR[e.status] || MUTED);
    const lai = el('span', 'ops-lai'); const sw = el('i', 'ops-sw'); sw.style.background = evColor(e); lai.append(sw, document.createTextNode(e.lai_type));
    const idc = td('ops-id', e.event_id);
    if (e.anomaly && isActive(e)) { const lv = el('span', 'ops-live'); const pu = el('i', 'ops-pulse'); lv.append(pu, el('span', 'ops-live-tag', 'Live')); idc.append(document.createTextNode(' '), lv); }
    tr.append(idc, td('', sev), td('', st), td('', lai), td('ops-hide-narrow', e.category), td('', e.location),
      td('ops-hide-narrow', fDT(e.startD)), td('is-num ops-hide-narrow', fmtInt(e.duration_h)), td('is-num ops-hide-narrow', fmtInt(e.peak_dev_pct)), td('is-num', fmtInt(e.excess_kwh)));
    return tr;
  }));
  $('#ev-count').textContent = `${vis.length} of ${ev.length} events`;
  if (!vis.length) { const tr = el('tr'); const c = el('td', 'ops-empty', 'No events match these filters.'); c.colSpan = 10; tr.append(c); body.append(tr); }
  return ev.find((e) => e.event_id === selId) || null;
}

// ---------- detail
function drawDetail(p, e) {
  const tBox = $('#trace-chart'), oBox = $('#overlay-chart');
  const facts = $('#detail-facts'), box = $('#detail-box'), badges = $('#detail-badges');
  if (!e) {
    $('#detail-title').textContent = 'Event details'; $('#detail-sub').textContent = 'No event matches the filters.';
    facts.replaceChildren(); box.replaceChildren(); badges.replaceChildren(); $('#detail-why').textContent = '';
    for (const b of [tBox, oBox]) { b.classList.remove('skeleton'); b.replaceChildren(el('p', 'ops-empty', 'Pick an event to see its readings.')); }
    return;
  }
  const mk = (tag, field, text, cls) => { const n = el(tag, cls, text); return n; };
  $('#detail-title').replaceChildren(mk('span', 'event_id', e.event_id), document.createTextNode(' · '), mk('span', 'category', e.category));
  $('#detail-sub').textContent = `${laiLabel(e.lai_type)} anomaly. ${(LAI.find((l) => l.key === e.lai_type) || {}).note || ''}`;
  const sev = mk('span', 'severity', e.severity, 'ops-sev'); sev.style.setProperty('--sev', SEV_COLOR[e.severity]);
  const st = mk('span', 'status', e.status, 'ops-pill'); st.style.setProperty('--pill', STATUS_COLOR[e.status] || MUTED);
  const lai = mk('span', 'lai_type', e.lai_type, 'ops-pill'); lai.style.setProperty('--pill', evColor(e));
  badges.replaceChildren(lai, st, sev);
  if (e.anomaly && isActive(e)) { const lv = el('span', 'ops-live'); lv.append(el('i', 'ops-pulse'), el('span', 'ops-live-tag', 'In progress')); badges.prepend(lv); }
  $('#detail-why').replaceChildren(mk('span', 'explanation', e.explanation));
  const tx = (x) => document.createTextNode(x);
  const rows = [
    ['Where', mk('span', 'location', e.location)],
    ['Sub-grid', mk('span', 'zone', e.zone)],
    ['Started', mk('span', 'start', fDT(e.startD))],
    [e.anomaly && isActive(e) ? 'Still active at' : 'Ended', mk('span', 'end', fDT(e.endD))],
    ['Duration', mk('span', 'duration_h', fmtInt(e.duration_h)), tx(` h (${fDur(e.duration_h)})`)],
    ['Peak deviation', mk('span', 'peak_dev_pct', fmtInt(e.peak_dev_pct)), tx(`% from ${e.anomaly ? 'normal' : 'expected'}`)],
    ['Excess energy', mk('span', 'excess_kwh', fmtInt(e.excess_kwh)), tx(' kWh')],
    ['Meters involved', mk('span', 'meters_affected', fmtInt(e.meters_affected))],
  ];
  facts.replaceChildren(...rows.flatMap(([k, ...v]) => { const dd = el('dd'); dd.append(...v); return [el('dt', null, k), dd]; }));
  box.classList.toggle('is-ok', !e.anomaly);
  if (!e.anomaly) {
    box.replaceChildren(el('h4', null, 'Explained, no action needed'), el('p', 'ops-sub', 'This deviation has a known, legitimate cause, so it is kept out of the open count. It stays visible so a reviewer can see why it was not raised.'));
  } else {
    const key = /meter reading|Data quality/.test(e.category) ? 'data' : e.lai_type;
    const ul = el('ul'); for (const s of RULE_OUT[key] || []) ul.append(el('li', null, s));
    box.replaceChildren(el('h4', null, 'Harmless causes to rule out first'), ul);
  }
  // trace
  const tr = get('event_traces', (r) => ({ id: r.event_id, t: parseTs(r.ts), kw: num(r.kw), exp: num(r.expected_kw) }));
  if (!tr) waiting(tBox, 'event_traces');
  else {
    const pts = tr.filter((r) => r.id === e.event_id);
    const isPoint = e.lai_type === 'global' && e.duration_h <= 1;
    const inWin = pts.filter((r) => r.t >= e.startD && r.t <= e.endD && r.kw != null);
    const span = pts.length ? pts[pts.length - 1].t - pts[0].t : 0;
    $('#trace-sub').textContent = isPoint ? 'Each dot is a reading flagged as a point outlier.' : 'The shaded span is the flagged period.';
    lineChart(tBox, {
      height: 240, label: 'Event readings', tipX: fDT, tipY: (v) => `${fmtInt(Math.round(v))} kW`,
      series: [{ name: 'Expected', color: REF, width: 1.5, dash: '5 4', points: pts.map((r) => ({ x: r.t, y: r.exp })) }, { name: 'Measured', color: FG, width: 1.5, points: pts.map((r) => ({ x: r.t, y: r.kw })) }],
      bands: isPoint ? [] : [{ x0: e.startD, x1: new Date(+e.endD + 900000), color: evColor(e), opacity: 0.22, label: e.anomaly ? 'Flagged period' : 'Explained period' }],
      dots: isPoint ? inWin.map((r) => ({ x: r.t, y: r.kw, color: evColor(e), r: 5 })) : [],
      empty: 'No readings were recorded for this event.',
    });
  }
  // overlay
  const ov = get('event_overlay', (r) => ({ id: r.event_id, series: r.series, day: r.day, h: Number(r.hour), kw: num(r.kw) }));
  if (!ov) waiting(oBox, 'event_overlay');
  else {
    const g = d3.groups(ov.filter((r) => r.id === e.event_id), (r) => r.series);
    const ser = g.map(([name, v], i) => ({ name: `${name} (${fDate(parseDay(v[0].day))})`, main: name === 'Event day', color: name === 'Event day' ? evColor(e) : MUTED, width: name === 'Event day' ? 2.25 : 1.25, opacity: name === 'Event day' ? 1 : Math.max(0.35, 0.95 - 0.15 * i), points: v.map((r) => ({ x: r.h, y: r.kw })) }));
    ser.sort((a, b) => a.main - b.main);
    const day = g.find(([n]) => n === 'Event day');
    $('#overlay-sub').textContent = day ? `${fDay(parseDay(day[1][0].day))}, the day with the largest gap, against the same weekday in the weeks before.` : 'No comparable days are available.';
    lineChart(oBox, { height: 200, label: 'Event day overlay', xType: 'linear', xDomain: [0, 24], xTicks: [0, 3, 6, 9, 12, 15, 18, 21, 24], xFmt: (h) => `${String(h % 24).padStart(2, '0')}:00`,
      tipX: (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`, tipY: (v) => `${fmtInt(Math.round(v))} kW`, series: ser, empty: 'No comparable days are available.' });
    const key = $('#overlay-key'); key.replaceChildren();
    for (const s of [...ser].reverse()) { const sp = el('span'); const k = el('i', 'ops-key-line'); k.style.borderTopColor = s.color; k.style.opacity = s.opacity; sp.append(k, document.createTextNode(s.name)); key.append(sp); }
  }
}

// ---------- scatter
function drawScatter(p, ev, selId) {
  const box = $('#scatter-chart');
  if (!ev) { waiting(box, 'events'); return; }
  box.classList.remove('skeleton'); box.replaceChildren();
  const vis = ev.filter((e) => passes(e, p) && e.peak_dev_pct > 0 && e.duration_h > 0);
  if (!vis.length) { box.append(el('p', 'ops-empty', 'No events match these filters.')); return; }
  const W = Math.max(260, box.clientWidth || 600), H = 300, bottom = H - 40;
  const xT = [0.25, 1, 6, 24, 168, 1000], xL = ['15 min', '1 h', '6 h', '1 day', '1 week', '6 weeks'];
  const yT = [10, 30, 100, 300, 1000];
  const y = d3.scaleLog([5, 2000], [bottom, 12]).clamp(true);
  const svg = d3.select(box).append('svg').attr('class', 'ops-svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Magnitude versus duration of events');
  const gy = svg.append('g').attr('class', 'ops-axis');
  const yl = gy.selectAll('text').data(yT).join('text').attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text((d) => `${fmtInt(d)}%`);
  let lw = 0; yl.each(function () { lw = Math.max(lw, this.getComputedTextLength()); });
  const ml = Math.ceil(lw) + 12, mr = 16;
  yl.attr('x', ml - 8);
  const x = d3.scaleLog([0.15, 1800], [ml, W - mr]).clamp(true);
  const r = d3.scaleSqrt([0, d3.max(vis, (e) => Math.abs(e.excess_kwh)) || 1], [3.5, Math.min(22, W / 30)]);
  const grid = svg.insert('g', ':first-child');
  grid.selectAll('.h').data(yT).join('line').attr('class', 'ops-grid').attr('x1', ml).attr('x2', W - mr).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  grid.selectAll('.v').data(xT).join('line').attr('class', 'ops-grid').attr('y1', 12).attr('y2', bottom).attr('x1', (d) => x(d)).attr('x2', (d) => x(d));
  svg.append('line').attr('class', 'ops-axisline').attr('x1', ml).attr('x2', W - mr).attr('y1', bottom).attr('y2', bottom);
  const gx = svg.append('g').attr('class', 'ops-axis'); let lastR = -Infinity;
  gx.selectAll('text').data(xT).join('text').attr('x', (d) => x(d)).attr('y', bottom + 16).attr('text-anchor', 'middle').text((d, i) => xL[i])
    .each(function (d) { const w = this.getComputedTextLength(), cx = x(d); if (cx - w / 2 < 0 || cx + w / 2 > W || cx - w / 2 < lastR + 8) this.remove(); else lastR = cx + w / 2; });
  svg.append('g').attr('class', 'ops-axis').append('text').attr('x', (ml + W - mr) / 2).attr('y', H - 4).attr('text-anchor', 'middle').text('Duration (log scale)');
  svg.append('g').attr('class', 'ops-axis').append('text').attr('x', ml).attr('y', 4).attr('dy', '0.32em').text('Peak deviation (log scale)');
  const tip = el('div', 'ops-tip'); tip.hidden = true; box.append(tip);
  const sorted = [...vis].sort((a, b) => Math.abs(b.excess_kwh) - Math.abs(a.excess_kwh));
  svg.append('g').selectAll('circle').data(sorted).join('circle')
    .attr('cx', (e) => x(e.duration_h)).attr('cy', (e) => y(e.peak_dev_pct)).attr('r', (e) => r(Math.abs(e.excess_kwh)))
    .style('fill', (e) => (e.anomaly ? laiColor(e.lai_type) : 'none')).attr('fill-opacity', 0.55)
    .style('stroke', (e) => (e.event_id === selId ? FG : e.anomaly ? laiColor(e.lai_type) : MUTED)).attr('stroke-width', (e) => (e.event_id === selId ? 2.5 : 1.25))
    .style('cursor', 'pointer')
    .on('click', (_, e) => selectEvent(e, true))
    .on('pointerenter', (ev2, e) => {
      tip.replaceChildren(el('div', 'ops-tip-h', `${e.event_id} · ${laiLabel(e.lai_type)}`), el('div', null, `${e.category} at ${e.location}`));
      const add = (n, v) => { const row = el('div', 'ops-tip-row'); row.append(el('span', null, n), el('b', null, v)); tip.append(row); };
      add('Duration', fDur(e.duration_h)); add('Peak deviation', `${fmtInt(e.peak_dev_pct)}%`); add('Excess energy', `${fmtInt(e.excess_kwh)} kWh`);
      if (!e.anomaly) tip.append(el('div', 'ops-tip-note', 'Explained event'));
      tip.hidden = false;
      const cx = x(e.duration_h), cy = y(e.peak_dev_pct), tw = tip.offsetWidth;
      let left = cx + 14; if (left + tw > W) left = cx - tw - 14;
      tip.style.left = `${Math.max(0, left)}px`; tip.style.top = `${Math.max(0, Math.min(cy - 20, H - tip.offsetHeight))}px`;
    })
    .on('pointerleave', () => { tip.hidden = true; });
}

// ---------- building drill-down
function drawBuilding(p, ev, bl, selEvent) {
  const sel = $('#f-building');
  if (!bl) { for (const id of ['#b-chart', '#b-break', '#d-trend', '#d-season', '#d-resid']) waiting($(id), 'buildings'); return; }
  if (sel.options.length !== bl.length) sel.replaceChildren(...[...bl].sort((a, b) => d3.ascending(a.building_id, b.building_id)).map((b) => new Option(`${b.name} (${b.building_id})`, b.building_id)));
  const bid = (p.building && bl.some((b) => b.building_id === p.building)) ? p.building : (selEvent && selEvent.building_id) || bl.find((b) => p.zone === 'all' || b.zone === p.zone).building_id;
  sel.value = bid;
  const b = bl.find((x) => x.building_id === bid);
  $('#b-title').textContent = `${b.name} drill-down`;
  const fact = (label, field, text) => { const s = el('span'); const v = el('b', null, text); s.append(document.createTextNode(`${label} `), v); return s; };
  $('#b-facts').replaceChildren(fact('Type', 'type', b.type), fact('Sub-grid', 'zone', b.zone), fact('Floor area', 'sqft', `${fmtInt(b.sqft)} sq ft`), fact('Submeters', 'meters', fmtInt(b.meters)), fact('Data received', 'completeness_pct', `${b.completeness_pct.toFixed(2)}%`));
  const bh = bHourly();
  const bevs = ev ? ev.filter((e) => e.building_id === bid && passes({ ...e, zone: b.zone }, { ...p, zone: 'all' })) : [];
  if (!bh) { for (const id of ['#b-chart', '#d-trend', '#d-season', '#d-resid']) waiting($(id), 'building_hourly'); }
  else {
    let pts = bh.filter((r) => r.b === bid);
    const rg = rangeOf(p, pts[pts.length - 1].t);
    if (rg) pts = pts.filter((r) => r.t >= rg[0] && r.t < rg[1]);
    const dom = rg || d3.extent(pts, (r) => r.t);
    const bb = bucket(pts, p.grain, ['kw', 'exp']);
    const bands = bevs.map((e) => ({ x0: e.startD, x1: new Date(+e.endD + 900000), color: evColor(e), opacity: e.event_id === p.event ? 0.32 : 0.18, label: `${e.event_id} · ${e.category}`, e }));
    lineChart($('#b-chart'), { height: 240, label: 'Building load vs expected', xDomain: dom, tipX: tipFmt(p.grain), tipY: (v) => `${fmtInt(Math.round(v))} kW`,
      series: [{ name: 'Expected', color: REF, width: 1.5, dash: '5 4', points: bb.map((r) => ({ x: r.t, y: r.exp })) }, { name: 'Measured', color: FG, width: p.grain === 'hour' ? 1.25 : 2, points: bb.map((r) => ({ x: r.t, y: r.kw })) }],
      bands, onBand: (bd) => selectEvent(bd.e, true), now: bh.length ? d3.max(pts, (r) => r.t) : null });
    const small = { xDomain: dom, tipX: fDT, tipY: (v) => `${fmtInt(Math.round(v))} kW` };
    lineChart($('#d-trend'), { ...small, height: 110, label: 'Trend', yZero: false, series: [{ name: 'Trend', color: FG, width: 2, points: pts.map((r) => ({ x: r.t, y: r.trend })) }], bands: bands.filter((x) => x.e.lai_type === 'trend') });
    lineChart($('#d-season'), { ...small, height: 110, label: 'Weekly pattern', symmetric: true, series: [{ name: 'Weekly pattern', color: 'var(--color-fg-muted)', width: 1.25, points: pts.map((r) => ({ x: r.t, y: r.season })) }] });
    lineChart($('#d-resid'), { ...small, height: 120, label: 'Residual', symmetric: true, series: [{ name: 'Residual', color: FG, width: 1.25, points: pts.map((r) => ({ x: r.t, y: r.resid })) }], bands, onBand: (bd) => selectEvent(bd.e, true) });
  }
  const bd = bDaily();
  const box = $('#b-break');
  if (!bd) { waiting(box, 'building_daily'); return; }
  box.classList.remove('skeleton'); box.replaceChildren();
  let days = bd.filter((r) => r.b === bid);
  const rg = rangeOf(p, new Date(+days[days.length - 1].t + 23 * 3600000));
  if (rg) days = days.filter((r) => r.t >= d3.utcDay.floor(rg[0]) && r.t < rg[1]);
  const keys = ['AHU', 'Lighting', 'Plug', 'Misc'];
  const ops = [0.9, 0.62, 0.4, 0.2];
  const stack = d3.stack().keys(keys).value((d, k) => d[k] || 0)(days);
  const W = Math.max(260, box.clientWidth || 600), H = 240, bottom = H - 22;
  const y = d3.scaleLinear([0, d3.max(days, (d) => d.kwh) || 1], [bottom, 8]).nice(5);
  const svg = d3.select(box).append('svg').attr('class', 'ops-svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Daily energy by load type');
  const ticks = y.ticks(5);
  const gy = svg.append('g').attr('class', 'ops-axis');
  const yl = gy.selectAll('text').data(ticks).join('text').attr('y', (d) => y(d)).attr('dy', '0.32em').attr('text-anchor', 'end').text(compact);
  let lw = 0; yl.each(function () { lw = Math.max(lw, this.getComputedTextLength()); });
  const ml = Math.ceil(lw) + 10; yl.attr('x', ml - 8);
  svg.insert('g', ':first-child').selectAll('line').data(ticks).join('line').attr('class', 'ops-grid').attr('x1', ml).attr('x2', W - 6).attr('y1', (d) => y(d)).attr('y2', (d) => y(d));
  const x = d3.scaleBand(days.map((d) => +d.t), [ml, W - 6]).paddingInner(days.length > 40 ? 0.15 : 0.25);
  stack.forEach((layer, i) => {
    svg.append('g').selectAll('rect').data(layer).join('rect').attr('x', (d) => x(+d.data.t)).attr('width', x.bandwidth())
      .attr('y', (d) => y(d[1])).attr('height', (d) => Math.max(0, y(d[0]) - y(d[1]))).style('fill', FG).attr('fill-opacity', ops[i]);
  });
  svg.append('line').attr('class', 'ops-axisline').attr('x1', ml).attr('x2', W - 6).attr('y1', bottom).attr('y2', bottom);
  const gx = svg.append('g').attr('class', 'ops-axis'); let lastR = -Infinity;
  gx.selectAll('text').data(days.filter((d) => d.t.getUTCDay() === 1 || days.length <= 10)).join('text').attr('x', (d) => x(+d.t) + x.bandwidth() / 2).attr('y', H - 4).attr('text-anchor', 'middle').text((d) => fDate(d.t))
    .each(function (d) { const w = this.getComputedTextLength(), cx = x(+d.t) + x.bandwidth() / 2; if (cx - w / 2 < 0 || cx + w / 2 > W || cx - w / 2 < lastR + 8) this.remove(); else lastR = cx + w / 2; });
  const tip = el('div', 'ops-tip'); tip.hidden = true; box.append(tip);
  svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - 6 - ml).attr('height', bottom).attr('fill', 'transparent')
    .on('pointermove', (e2) => {
      const [mx] = d3.pointer(e2, svg.node()); const i = Math.floor((mx - ml) / x.step()); const d = days[Math.max(0, Math.min(days.length - 1, i))];
      tip.replaceChildren(el('div', 'ops-tip-h', fDay(d.t)));
      keys.forEach((k, j) => { const row = el('div', 'ops-tip-row'); const sw = el('i', 'ops-sw'); sw.style.background = FG; sw.style.opacity = ops[j]; row.append(sw, el('span', null, k), el('b', null, d[k] == null ? 'No data' : `${fmtInt(d[k])} kWh`)); tip.append(row); });
      tip.hidden = false; const cx = x(+d.t); const tw = tip.offsetWidth; let left = cx + 14; if (left + tw > W) left = cx - tw - 14; tip.style.left = `${Math.max(0, left)}px`; tip.style.top = '6px';
    }).on('pointerleave', () => { tip.hidden = true; });
  const key = $('#b-break-key'); key.replaceChildren(...keys.map((k, j) => { const s = el('span'); const sw = el('i', 'ops-sw'); sw.style.background = FG; sw.style.opacity = ops[j]; s.append(sw, document.createTextNode(k)); return s; }));
}

// ---------- main
const safe = (fn) => { try { fn(); } catch (err) { setTimeout(() => { throw err; }); } };
let firstNav = true;
function drawAll() {
  const p = P();
  const ev = events(), bl = buildings();
  safe(() => drawFilters(p, bl));
  safe(() => drawHeader(p));
  safe(() => drawNow(p, ev));
  safe(() => drawSubgrid(p, ev));
  safe(() => drawHeatmap(p, ev, bl));
  safe(() => drawMix(p));
  let selEvent = null;
  safe(() => { selEvent = drawTable(p, ev); });
  safe(() => drawDetail(p, selEvent));
  safe(() => drawScatter(p, ev, selEvent && selEvent.event_id));
  safe(() => drawBuilding(p, ev, bl, selEvent));
  if (firstNav && ev) {
    firstNav = false;
    const named = document.getElementById(location.hash.slice(1));
    if (named && named.closest('.ops')) named.scrollIntoView();
  }
}
store.onData(drawAll);

