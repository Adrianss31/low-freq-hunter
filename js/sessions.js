// Riepilogo: lista sessioni, dettaglio (timeline, waterfall, eventi, marker,
// clip audio) ed export CSV / JSON / report PNG.
'use strict';

import { BAND_COLORS, BAND_KEYS } from './config.js';
import { dbAll, dbGet, dbBySession, deleteSessionData } from './db.js';
import { showToast, fmtClock, fmtDate, fmtDur, fmtIso, download, drawWaterfall, setupCanvas } from './ui.js';
import { renderReportPng } from './report.js';

const $ = id => document.getElementById(id);
let cur = null; // { session, samples, events, gaps, markers, slices, clips }

export async function loadSessions() {
  const sessions = await dbAll('sessions');
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  const list = $('sessions-list');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<div class="empty-msg">Nessuna sessione salvata.<br>Avvia un log notturno per iniziare.</div>';
    return;
  }
  for (const s of sessions) {
    const el = document.createElement('div');
    el.className = 'session-item';
    const dur = s.endedAt ? fmtDur((s.endedAt - s.startedAt) / 1000) : 'in corso';
    const rec = s.recovered ? ' · <span style="color:var(--amber)">recuperata</span>' : '';
    el.innerHTML = `<div><div class="s-name">${s.label}</div>
      <div class="s-meta">${fmtDate(s.startedAt)} ${fmtClock(s.startedAt)} · ${dur}${rec}</div></div>
      <div class="s-badge">${s.eventsCount || 0} eventi</div>`;
    el.onclick = () => openSession(s.id);
    list.appendChild(el);
  }
}

export async function openSession(id) {
  const session = await dbGet('sessions', id);
  if (!session) return;
  const [samples, allEvents, markers, slices, clips] = await Promise.all([
    dbBySession('samples', id), dbBySession('events', id),
    dbBySession('markers', id), dbBySession('slices', id), dbBySession('clips', id),
  ]);
  samples.sort((a, b) => a.t - b.t);
  allEvents.sort((a, b) => a.startT - b.startT);
  markers.sort((a, b) => a.t - b.t);
  slices.sort((a, b) => a.t - b.t);
  const events = allEvents.filter(e => e.band !== 'gap');
  const gaps = allEvents.filter(e => e.band === 'gap');
  cur = { session, samples, events, gaps, markers, slices, clips };

  $('sessions-list').style.display = 'none';
  $('session-detail').style.display = 'flex';
  $('detail-title').textContent = session.label;

  drawTimeline();
  drawSessionWf();
  renderStats();
  renderEvents();
  renderMarkers();
  renderClips();
}

export function backToList() {
  cur = null;
  $('session-detail').style.display = 'none';
  $('sessions-list').style.display = 'flex';
  loadSessions();
}

// ── Timeline: livelli per banda + regioni evento + marker + gap ─────────────
function drawTimeline() {
  const { session, samples, events, gaps, markers } = cur;
  const { ctx, W, H } = setupCanvas($('timeline-canvas'), 170);
  ctx.fillStyle = '#111118';
  ctx.fillRect(0, 0, W, H);
  if (samples.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,.3)';
    ctx.font = '11px system-ui';
    ctx.fillText('Nessun campione registrato.', 10, 20);
    return;
  }
  const laneH = 8; // corsie evento in alto, una per banda
  const plotY0 = laneH * 3 + 6, plotH = H - plotY0 - 14;
  const tMin = samples[0].t, tMax = samples[samples.length - 1].t;
  const tSpan = Math.max(1, tMax - tMin);
  const dbMin = -110, dbMax = -10;
  const xOf = t => (t - tMin) / tSpan * W;
  const yOf = db => plotY0 + plotH - (Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin) * plotH;

  // Gap: colonne grigie su tutta l'altezza
  for (const g of gaps) {
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    ctx.fillRect(xOf(g.startT), 0, Math.max(xOf(g.endT) - xOf(g.startT), 2), H);
  }

  // Corsie evento
  BAND_KEYS.forEach((k, i) => {
    const y = i * laneH + 2;
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    ctx.fillRect(0, y, W, laneH - 2);
    ctx.fillStyle = BAND_COLORS[k];
    ctx.font = '8px monospace';
    ctx.fillText(k, 2, y + laneH - 3);
    for (const ev of events.filter(e => e.band === k)) {
      ctx.fillRect(xOf(ev.startT), y, Math.max(xOf(ev.endT) - xOf(ev.startT), 2), laneH - 2);
    }
  });

  // Griglia dB
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.fillStyle = 'rgba(255,255,255,.25)';
  ctx.font = '8px monospace';
  for (let db = -100; db <= -20; db += 20) {
    const y = yOf(db);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(db + '', 2, y - 1);
  }

  // Linee di soglia (dalla config salvata nella sessione)
  const sCfg = session.cfg;
  if (sCfg?.bands) {
    ctx.setLineDash([3, 4]);
    for (const k of BAND_KEYS) {
      if (!sCfg.bands[k]?.enabled) continue;
      ctx.strokeStyle = BAND_COLORS[k] + '80';
      const y = yOf(sCfg.bands[k].thr);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Curve di livello: ref (grigia) + bande
  const stride = Math.max(1, Math.floor(samples.length / (W * 1.5)));
  const plotLine = (getter, color, width) => {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < samples.length; i += stride) {
      const v = getter(samples[i]);
      if (v === null || v === undefined || !isFinite(v)) { started = false; continue; }
      const x = xOf(samples[i].t), y = yOf(v);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };
  plotLine(s => s.ref, 'rgba(255,255,255,.22)', 1);
  const keyOf = { A: 'a', B: 'b', C: 'c' };
  for (const k of BAND_KEYS) {
    if (!sCfg?.bands?.[k]?.enabled) continue;
    plotLine(s => s[keyOf[k]], BAND_COLORS[k], 1.2);
  }

  // Marker: triangolini bianchi
  for (const m of markers) {
    const x = xOf(m.t);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x - 4, 8); ctx.lineTo(x + 4, 8); ctx.closePath();
    ctx.fill();
  }

  // Etichette temporali
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.font = '9px monospace';
  for (let i = 0; i <= 4; i++) {
    const t = tMin + tSpan * i / 4;
    const lbl = fmtClock(t * 1000);
    const x = Math.min((i / 4) * W + 2, W - ctx.measureText(lbl).width - 2);
    ctx.fillText(lbl, x, H - 3);
  }
}

function drawSessionWf() {
  const { session, slices } = cur;
  const wrap = $('detail-wf-wrap');
  if (!slices.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const { ctx, W, H } = setupCanvas($('detail-wf-canvas'), 110);
  const guides = [];
  for (const k of BAND_KEYS) {
    if (session.cfg?.bands?.[k]?.enabled) guides.push({ hz: session.cfg.bands[k].center, color: BAND_COLORS[k] + 'aa' });
  }
  drawWaterfall(ctx, W, H, slices, {
    guides, startMs: session.startedAt, endMs: session.endedAt || Date.now(),
  });
}

function renderStats() {
  const { session, samples, events, gaps, markers } = cur;
  const totalS = session.endedAt ? (session.endedAt - session.startedAt) / 1000 : 0;
  const noisyS = events.reduce((s, e) => s + e.durationS, 0);
  const longest = events.reduce((m, e) => Math.max(m, e.durationS), 0);
  const peak = events.reduce((m, e) => Math.max(m, e.peakDb ?? -Infinity), -Infinity);
  const gapS = gaps.reduce((s, g) => s + g.durationS, 0);
  const perBand = BAND_KEYS.map(k => {
    const n = events.filter(e => e.band === k).length;
    return n ? `<span style="color:${BAND_COLORS[k]}">${k}:${n}</span>` : null;
  }).filter(Boolean).join(' ');
  $('summary-stats').innerHTML = `
    <div class="stat-item"><div class="s-lbl">Durata</div><div class="s-val">${fmtDur(totalS)}</div></div>
    <div class="stat-item"><div class="s-lbl">Eventi</div><div class="s-val">${events.length} <small>${perBand}</small></div></div>
    <div class="stat-item"><div class="s-lbl">Tempo sopra soglia</div><div class="s-val">${fmtDur(noisyS)}</div></div>
    <div class="stat-item"><div class="s-lbl">Evento più lungo</div><div class="s-val">${fmtDur(longest)}</div></div>
    <div class="stat-item"><div class="s-lbl">Picco max</div><div class="s-val">${isFinite(peak) ? peak.toFixed(1) + ' dBFS' : '—'}</div></div>
    <div class="stat-item"><div class="s-lbl">Marker</div><div class="s-val">${markers.length}</div></div>
    ${gapS ? `<div class="stat-item" style="grid-column:1/-1"><div class="s-lbl">⚠ Monitoraggio interrotto per</div><div class="s-val" style="color:var(--amber)">${fmtDur(gapS)} (${gaps.length} gap)</div></div>` : ''}`;
}

function renderEvents() {
  const { events, gaps } = cur;
  const tbody = $('events-tbody');
  tbody.innerHTML = '';
  const rows = [...events, ...gaps].sort((a, b) => a.startT - b.startT);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">Nessun evento sopra soglia.</td></tr>';
    return;
  }
  let n = 0;
  for (const ev of rows) {
    const tr = document.createElement('tr');
    if (ev.band === 'gap') {
      tr.innerHTML = `<td>—</td><td>${fmtClock(ev.startT * 1000)}</td><td>${fmtClock(ev.endT * 1000)}</td>
        <td>${fmtDur(ev.durationS)}</td><td colspan="2" style="color:var(--text3)">gap monitoraggio</td>`;
      tr.style.opacity = '.55';
    } else {
      n++;
      tr.innerHTML = `<td>${n}</td><td>${fmtClock(ev.startT * 1000)}</td><td>${fmtClock(ev.endT * 1000)}</td>
        <td>${fmtDur(ev.durationS)}</td><td class="mono">${ev.peakDb?.toFixed(1) ?? '—'}</td>
        <td><span style="color:${BAND_COLORS[ev.band] || '#fff'}">${ev.band}</span></td>`;
    }
    tbody.appendChild(tr);
  }
}

function renderMarkers() {
  const { markers } = cur;
  const wrap = $('markers-wrap');
  if (!markers.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  $('markers-list').innerHTML = markers.map(m =>
    `<div class="marker-row">▲ ${fmtClock(m.t * 1000)} — "lo sento adesso"${m.origin === 'blackout' ? ' (da schermo nero)' : ''}</div>`
  ).join('');
}

function renderClips() {
  const { clips } = cur;
  const wrap = $('clips-wrap');
  if (!clips.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  const list = $('clips-list');
  list.innerHTML = '';
  clips.sort((a, b) => a.t - b.t);
  for (const c of clips) {
    const row = document.createElement('div');
    row.className = 'clip-row';
    const ext = c.mime.includes('mp4') ? 'm4a' : 'webm';
    row.innerHTML = `<span style="color:${BAND_COLORS[c.band] || '#fff'}">${c.band}</span>
      <span class="mono">${fmtClock(c.t * 1000)}</span>`;
    const play = document.createElement('button');
    play.className = 'btn btn-sm';
    play.textContent = '▶';
    play.onclick = () => {
      const a = new Audio(URL.createObjectURL(c.blob));
      a.play();
      a.onended = () => URL.revokeObjectURL(a.src);
    };
    const dl = document.createElement('button');
    dl.className = 'btn btn-sm';
    dl.textContent = '⬇';
    dl.onclick = () => download(c.blob, `clip_${c.band}_${fmtIso(c.t).replace(/[:.]/g, '-')}.${ext}`);
    row.append(play, dl);
    list.appendChild(row);
  }
}

// ── Export ──────────────────────────────────────────────────────────────────
function baseName() {
  return cur.session.label.replace(/\W+/g, '_');
}

export function exportEventsCsv() {
  const { session, events, gaps } = cur;
  const b = session.cfg?.bands || {};
  const lines = ['index,band,center_hz,width_hz,threshold_dbfs,start_iso,end_iso,duration_s,peak_dbfs,avg_dbfs'];
  let n = 0;
  for (const ev of [...events, ...gaps].sort((x, y) => x.startT - y.startT)) {
    if (ev.band === 'gap') {
      lines.push(`,GAP,,,,${fmtIso(ev.startT)},${fmtIso(ev.endT)},${ev.durationS},,`);
    } else {
      n++;
      const bc = b[ev.band] || {};
      lines.push(`${n},${ev.band},${bc.center ?? ''},${bc.width ?? ''},${bc.thr ?? ''},${fmtIso(ev.startT)},${fmtIso(ev.endT)},${ev.durationS},${ev.peakDb?.toFixed(2) ?? ''},${ev.avgDb?.toFixed(2) ?? ''}`);
    }
  }
  download(new Blob([lines.join('\n')], { type: 'text/csv' }), `${baseName()}_eventi.csv`);
}

export function exportSamplesCsv() {
  const { samples } = cur;
  const lines = ['t_iso,t_epoch_s,band_a_dbfs,band_b_dbfs,band_c_dbfs,broadband_20_500_dbfs,dominant_hz'];
  for (const s of samples) {
    lines.push(`${fmtIso(s.t)},${s.t},${s.a?.toFixed(2) ?? ''},${s.b?.toFixed(2) ?? ''},${s.c?.toFixed(2) ?? ''},${s.ref?.toFixed(2) ?? ''},${s.domHz ?? ''}`);
  }
  download(new Blob([lines.join('\n')], { type: 'text/csv' }), `${baseName()}_campioni.csv`);
}

export function exportJson() {
  const { session, samples, events, gaps, markers, clips } = cur;
  const data = {
    app: 'low-freq-hunter', format: 2, exportedAt: new Date().toISOString(),
    note: 'Livelli in dBFS (relativi al fondo scala del microfono), non calibrati in dB SPL.',
    session, events, gaps, markers, samples,
    clipsCount: clips.length,
  };
  download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `${baseName()}.json`);
}

export async function exportReport() {
  try {
    const blob = await renderReportPng(cur);
    download(blob, `${baseName()}_report.png`);
  } catch (e) {
    showToast('Errore generazione report: ' + e.message, 4000);
  }
}

export async function deleteCurrent() {
  if (!cur) return;
  if (!confirm('Eliminare questa sessione e tutti i suoi dati (campioni, eventi, clip)?')) return;
  await deleteSessionData(cur.session.id);
  showToast('Sessione eliminata');
  backToList();
}
