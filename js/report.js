// Report PNG: un'unica immagine autocontenuta con metadati, waterfall,
// timeline ed elenco eventi — pensata per essere allegata come documentazione.
'use strict';

import { BAND_COLORS, BAND_KEYS } from './config.js';
import { fmtClock, fmtDate, fmtDur, drawWaterfall } from './ui.js';

const W = 1400;

export async function renderReportPng(data) {
  const { session, samples, events, gaps, markers, slices } = data;
  const evRows = Math.min(events.length + gaps.length, 28);
  const H = 560 + evRows * 22 + 60;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 22px system-ui';
  ctx.fillText('Low-Freq Hunter — Report sessione', 30, 40);

  ctx.font = '13px system-ui';
  ctx.fillStyle = '#333';
  const startStr = `${fmtDate(session.startedAt)} ${fmtClock(session.startedAt)}`;
  const endStr = session.endedAt ? `${fmtDate(session.endedAt)} ${fmtClock(session.endedAt)}` : '—';
  const durStr = session.endedAt ? fmtDur((session.endedAt - session.startedAt) / 1000) : '—';
  const bandsStr = BAND_KEYS.filter(k => session.cfg?.bands?.[k]?.enabled)
    .map(k => { const b = session.cfg.bands[k]; return `${k}: ${b.center}±${b.width} Hz @ ${b.thr} dBFS`; })
    .join('   ·   ');
  const lines = [
    `Sessione: ${session.label}     Inizio: ${startStr}     Fine: ${endStr}     Durata: ${durStr}`,
    `Bande monitorate: ${bandsStr}`,
    `Trigger: ≥${session.cfg?.minOnS ?? '?'} s sopra soglia per aprire, ≥${session.cfg?.minOffS ?? '?'} s sotto per chiudere (isteresi ${session.cfg?.hystDb ?? '?'} dB)`,
    `FFT ${session.cfg?.fftSize ?? '?'} punti @ ${session.sampleRate ?? '?'} Hz (≈${session.binHz ? session.binHz.toFixed(2) : '?'} Hz/bin) · Livelli in dBFS, non calibrati in dB SPL`,
  ];
  lines.forEach((l, i) => ctx.fillText(l, 30, 68 + i * 20));

  // Waterfall
  let y = 165;
  ctx.font = 'bold 13px system-ui';
  ctx.fillStyle = '#111';
  ctx.fillText('Spettrogramma 20–200 Hz (tutta la sessione)', 30, y - 6);
  ctx.save();
  ctx.translate(30, y);
  if (slices.length) {
    const guides = BAND_KEYS.filter(k => session.cfg?.bands?.[k]?.enabled)
      .map(k => ({ hz: session.cfg.bands[k].center, color: BAND_COLORS[k] }));
    drawWaterfall(ctx, W - 60, 150, slices, { guides, startMs: session.startedAt, endMs: session.endedAt || Date.now(), light: false });
    ctx.strokeStyle = '#ccc';
    ctx.strokeRect(0, 0, W - 60, 150);
  } else {
    ctx.fillStyle = '#888'; ctx.font = '12px system-ui';
    ctx.fillText('Nessuno spettrogramma salvato.', 0, 20);
  }
  ctx.restore();

  // Timeline livelli
  y += 185;
  ctx.font = 'bold 13px system-ui';
  ctx.fillStyle = '#111';
  ctx.fillText('Livelli di banda nel tempo (dBFS) — regioni colorate = eventi sopra soglia, grigie = gap', 30, y - 6);
  drawReportTimeline(ctx, 30, y, W - 60, 130, data);

  // Tabella eventi
  y += 165;
  ctx.font = 'bold 13px system-ui';
  ctx.fillStyle = '#111';
  ctx.fillText(`Eventi rilevati (${events.length})${markers.length ? ` · Marker manuali: ${markers.length}` : ''}`, 30, y - 6);
  ctx.font = '12px monospace';
  ctx.fillStyle = '#555';
  ctx.fillText('#    banda   inizio      fine        durata      picco dBFS   media dBFS', 30, y + 14);
  const rows = [...events, ...gaps].sort((a, b) => a.startT - b.startT).slice(0, 28);
  let n = 0;
  rows.forEach((ev, i) => {
    const ry = y + 34 + i * 22;
    if (ev.band === 'gap') {
      ctx.fillStyle = '#999';
      ctx.fillText(`—    GAP     ${fmtClock(ev.startT * 1000)}    ${fmtClock(ev.endT * 1000)}    ${fmtDur(ev.durationS).padEnd(10)}  monitoraggio interrotto`, 30, ry);
    } else {
      n++;
      ctx.fillStyle = '#222';
      ctx.fillText(
        `${String(n).padEnd(4)} ${ev.band}       ${fmtClock(ev.startT * 1000)}    ${fmtClock(ev.endT * 1000)}    ${fmtDur(ev.durationS).padEnd(10)}  ${(ev.peakDb?.toFixed(1) ?? '—').padEnd(12)} ${ev.avgDb?.toFixed(1) ?? '—'}`,
        30, ry);
      ctx.fillStyle = BAND_COLORS[ev.band] || '#000';
      ctx.fillRect(62, ry - 9, 8, 8);
    }
  });
  if (events.length + gaps.length > 28) {
    ctx.fillStyle = '#888';
    ctx.fillText(`… e altri ${events.length + gaps.length - 28} (vedi CSV)`, 30, y + 34 + 28 * 22);
  }

  ctx.fillStyle = '#aaa';
  ctx.font = '11px system-ui';
  ctx.fillText(`Generato il ${new Date().toLocaleString('it-IT')} — Low-Freq Hunter (misura indicativa, non fonometria certificata)`, 30, H - 16);

  return new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('toBlob fallito')), 'image/png'));
}

function drawReportTimeline(ctx, x0, y0, w, h, data) {
  const { session, samples, events, gaps, markers } = data;
  ctx.save();
  ctx.translate(x0, y0);
  ctx.fillStyle = '#fafafa';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#ccc';
  ctx.strokeRect(0, 0, w, h);
  if (samples.length < 2) { ctx.restore(); return; }

  const tMin = samples[0].t, tMax = samples[samples.length - 1].t;
  const tSpan = Math.max(1, tMax - tMin);
  const dbMin = -110, dbMax = -10;
  const xOf = t => (t - tMin) / tSpan * w;
  const yOf = db => h - (Math.max(dbMin, Math.min(dbMax, db)) - dbMin) / (dbMax - dbMin) * h;

  for (const g of gaps) {
    ctx.fillStyle = 'rgba(0,0,0,.10)';
    ctx.fillRect(xOf(g.startT), 0, Math.max(xOf(g.endT) - xOf(g.startT), 2), h);
  }
  for (const ev of events) {
    ctx.fillStyle = (BAND_COLORS[ev.band] || '#888') + '30';
    ctx.fillRect(xOf(ev.startT), 0, Math.max(xOf(ev.endT) - xOf(ev.startT), 2), h);
  }

  ctx.strokeStyle = '#e5e5e5';
  ctx.fillStyle = '#999';
  ctx.font = '10px monospace';
  for (let db = -100; db <= -20; db += 20) {
    const y = yOf(db);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.fillText(db + '', 4, y - 2);
  }

  const sCfg = session.cfg;
  ctx.setLineDash([4, 4]);
  for (const k of BAND_KEYS) {
    if (!sCfg?.bands?.[k]?.enabled) continue;
    ctx.strokeStyle = BAND_COLORS[k];
    const y = yOf(sCfg.bands[k].thr);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  const stride = Math.max(1, Math.floor(samples.length / (w * 1.5)));
  const keyOf = { A: 'a', B: 'b', C: 'c' };
  const plotLine = (getter, color, width) => {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < samples.length; i += stride) {
      const v = getter(samples[i]);
      if (v === null || v === undefined || !isFinite(v)) { started = false; continue; }
      const px = xOf(samples[i].t), py = yOf(v);
      started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      started = true;
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };
  plotLine(s => s.ref, '#bbb', 1);
  for (const k of BAND_KEYS) {
    if (!sCfg?.bands?.[k]?.enabled) continue;
    plotLine(s => s[keyOf[k]], BAND_COLORS[k], 1.4);
  }

  for (const m of markers) {
    const x = xOf(m.t);
    ctx.fillStyle = '#d40000';
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x - 5, 10); ctx.lineTo(x + 5, 10); ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = '#666';
  ctx.font = '10px monospace';
  for (let i = 0; i <= 6; i++) {
    const t = tMin + tSpan * i / 6;
    const lbl = fmtClock(t * 1000);
    const x = Math.min((i / 6) * w + 2, w - ctx.measureText(lbl).width - 2);
    ctx.fillText(lbl, x, h - 4);
  }
  ctx.restore();
}
