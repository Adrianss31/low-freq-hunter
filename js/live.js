// Modalità Live: spettro in tempo reale, waterfall scorrevole, meter per
// banda con soglie, picco, freeze, sonificazione, confronto A/B.
'use strict';

import { cfg, bandRange, bandLabel, enabledBands, getBand, bandColor } from './config.js';
import * as audio from './audio.js';
import { setupCanvas, wfColor, showToast } from './ui.js';

export let liveRunning = false;
let raf = null, frozen = false;
let selBand = 'B';
let peakDb = -Infinity;
let capA = null, capB = null;

const $ = id => document.getElementById(id);

// Waterfall scorrevole: buffer offscreen, 1 colonna ogni 100 ms (~30 s visibili).
const WF_COLS = 300, WF_ROWS = 64, WF_FMIN = 20, WF_FMAX = 200;
let wfBuf = null, wfBufCtx = null, lastWfCol = 0;

function drawSpectrum(fd) {
  const { ctx, W, H } = setupCanvas($('spectrum-canvas'), Math.min(200, Math.round(($('spectrum-canvas').clientWidth || 300) * 0.42)));
  ctx.fillStyle = '#0d0d16';
  ctx.fillRect(0, 0, W, H);
  if (!fd) return;

  const bh = audio.binHz(), xMax = cfg.specXMax;
  const dbMin = -120, dbMax = 0;
  const xOf = f => f / xMax * W;
  const yOf = db => H - (db - dbMin) / (dbMax - dbMin) * H;

  // Griglia
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.fillStyle = 'rgba(255,255,255,.25)';
  ctx.lineWidth = 1;
  ctx.font = '9px monospace';
  for (let db = -100; db <= 0; db += 20) {
    const y = yOf(db);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(db + '', 2, y - 2);
  }
  const fStep = xMax <= 250 ? 50 : xMax <= 500 ? 100 : 200;
  for (let f = fStep; f < xMax; f += fStep) {
    const x = xOf(f);
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillText(f + 'Hz', x + 2, H - 3);
  }

  // Evidenzia bande + segmento orizzontale alla soglia
  for (const k of enabledBands()) {
    const r = bandRange(k), c = bandColor(k);
    const x0 = xOf(r.lo), x1 = xOf(r.hi);
    if (x0 > W) continue;
    ctx.fillStyle = c + '18';
    ctx.fillRect(x0, 0, Math.max(x1 - x0, 2), H);
    const y = yOf(getBand(k).thr);
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(Math.min(x1, W), y); ctx.stroke();
  }

  // Curva dello spettro
  const maxBin = Math.min(Math.ceil(xMax / bh), fd.length - 1);
  ctx.beginPath();
  for (let i = 0; i <= maxBin; i++) {
    const x = xOf(i * bh), y = yOf(fd[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.lineTo(xOf(maxBin * bh), H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = 'rgba(0,212,170,.07)'; ctx.fill();
  ctx.beginPath();
  for (let i = 0; i <= maxBin; i++) {
    const x = xOf(i * bh), y = yOf(fd[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#00d4aa'; ctx.lineWidth = 1.5; ctx.stroke();

  // Marker centri banda
  for (const k of enabledBands()) {
    const f = getBand(k).center, x = xOf(f);
    if (x < 0 || x > W) continue;
    ctx.strokeStyle = bandColor(k);
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = bandColor(k);
    ctx.font = 'bold 9px monospace';
    ctx.fillText(k + ' ' + f, x + 2, 11);
  }
}

function pushWfColumn(fd) {
  if (!wfBuf) {
    wfBuf = document.createElement('canvas');
    wfBuf.width = WF_COLS; wfBuf.height = WF_ROWS;
    wfBufCtx = wfBuf.getContext('2d');
    wfBufCtx.fillStyle = '#000'; wfBufCtx.fillRect(0, 0, WF_COLS, WF_ROWS);
  }
  // scorri a sinistra di 1 colonna
  wfBufCtx.drawImage(wfBuf, -1, 0);
  const bh = audio.binHz();
  for (let r = 0; r < WF_ROWS; r++) {
    const fL = WF_FMIN + (r / WF_ROWS) * (WF_FMAX - WF_FMIN);
    const fH = WF_FMIN + ((r + 1) / WF_ROWS) * (WF_FMAX - WF_FMIN);
    const i0 = Math.max(0, Math.round(fL / bh));
    const i1 = Math.min(fd.length - 1, Math.round(fH / bh));
    let p = 0, n = 0;
    for (let i = i0; i <= i1; i++) { p += Math.pow(10, fd[i] / 10); n++; }
    const db = n ? 10 * Math.log10(p / n + 1e-12) : -120;
    wfBufCtx.fillStyle = wfColor((db + 100) / 70);
    wfBufCtx.fillRect(WF_COLS - 1, WF_ROWS - 1 - r, 1, 1);
  }
}

function drawWfLive() {
  const cv = $('live-wf-canvas');
  const { ctx, W, H } = setupCanvas(cv, 90);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (wfBuf) ctx.drawImage(wfBuf, 0, 0, WF_COLS, WF_ROWS, 0, 0, W, H);
  // guide bande
  ctx.font = '8px monospace';
  for (const k of enabledBands()) {
    const f = getBand(k).center;
    const y = H - (f - WF_FMIN) / (WF_FMAX - WF_FMIN) * H;
    if (y < 0 || y > H) continue;
    ctx.fillStyle = bandColor(k);
    ctx.fillRect(0, y, 6, 1);
    ctx.fillText(String(f), 8, y + 3);
  }
}

// Ricostruisce le righe dei meter se l'elenco delle bande attive è cambiato.
let meterSig = '';
function syncMeterRows() {
  const ids = enabledBands();
  const sig = ids.join(',');
  if (sig === meterSig) return;
  meterSig = sig;
  $('live-meters').innerHTML = ids.map(k => `
    <div class="lm-row" id="lm-row-${k}">
      <span class="lm-name" id="lm-name-${k}">${bandLabel(k)}</span>
      <div class="lm-track"><div class="lm-fill" id="lm-fill-${k}" style="background:${bandColor(k)}"></div><div class="lm-thr" id="lm-thr-${k}"></div></div>
      <span class="lm-val mono" id="lm-val-${k}">—</span>
    </div>`).join('');
}

function updateMeters(lv) {
  for (const k of enabledBands()) {
    const fill = $('lm-fill-' + k);
    if (!fill) continue;
    const b = getBand(k), db = lv[k];
    const pct = Math.max(0, Math.min(100, (db + 120) / 120 * 100));
    const thrPct = Math.max(0, Math.min(100, (b.thr + 120) / 120 * 100));
    fill.style.width = pct + '%';
    $('lm-thr-' + k).style.left = thrPct + '%';
    $('lm-val-' + k).textContent = isFinite(db) ? db.toFixed(1) : '—';
    $('lm-val-' + k).style.color = db >= b.thr ? 'var(--red)' : '';
  }
}

function tick() {
  if (!liveRunning) { raf = null; return; }
  const fd = audio.spectrum();
  if (fd) {
    if (!frozen) {
      drawSpectrum(fd);
      const now = performance.now();
      if (now - lastWfCol >= 100) { lastWfCol = now; pushWfColumn(fd); drawWfLive(); }
    }
    const lv = {};
    for (const k of enabledBands()) {
      const r = bandRange(k);
      lv[k] = audio.bandDb(fd, r.lo, r.hi);
    }
    updateMeters(lv);
    const sel = lv[selBand];
    if (sel !== undefined) {
      $('live-db').textContent = isFinite(sel) ? sel.toFixed(1) : '—';
      if (sel > peakDb) peakDb = sel;
      $('live-peak').textContent = isFinite(peakDb) ? peakDb.toFixed(1) : '—';
      if (audio.isSonifying()) audio.setSonifyLevel(sel);
    }
  }
  raf = requestAnimationFrame(tick);
}

// Decadimento lento del picco
setInterval(() => { if (liveRunning && isFinite(peakDb)) peakDb = Math.max(peakDb - 0.3, -120); }, 400);

export async function startLive() {
  if (liveRunning) return;
  const res = await audio.startAudio(cfg.smoothLive);
  if (!res.ok) { showToast(res.error, 5000); return; }
  liveRunning = true;
  peakDb = -Infinity;
  syncButtons();
  raf = requestAnimationFrame(tick);
}

export function stopLive(keepAudio = false) {
  if (!liveRunning) return;
  liveRunning = false;
  frozen = false;
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  audio.stopSonify();
  if (!keepAudio) audio.stopAudio();
  syncButtons();
  $('live-db').textContent = '—';
}

function syncButtons() {
  const b = $('btn-live-start');
  b.textContent = liveRunning ? '⬛ Stop' : '▶ Avvia';
  b.classList.toggle('primary', !liveRunning);
  b.classList.toggle('danger', liveRunning);
  ['btn-freeze', 'btn-sonify', 'btn-cap-a', 'btn-cap-b'].forEach(id => { $(id).disabled = !liveRunning; });
  $('btn-freeze').textContent = frozen ? '▶ Riprendi' : '❄ Freeze';
  $('btn-freeze').classList.toggle('active-state', frozen);
  $('btn-sonify').textContent = audio.isSonifying() ? '🔇 Stop suono' : '🔊 Geiger';
  $('btn-sonify').classList.toggle('active-state', audio.isSonifying());
}

export function refreshBandUi() {
  const ids = enabledBands();
  if (!ids.includes(selBand)) selBand = ids[0] || null;
  $('band-selector').innerHTML = ids.map(k =>
    `<button class="band-btn${k === selBand ? ' active' : ''}" data-band="${k}">${bandLabel(k)}</button>`
  ).join('');
  $('live-sel-label').textContent = selBand ? bandLabel(selBand) : '—';
  meterSig = ''; // etichette/colori possono essere cambiati: forza il rebuild
  syncMeterRows();
}

export function initLive() {
  $('btn-live-start').addEventListener('click', () => liveRunning ? stopLive() : startLive());
  $('btn-freeze').addEventListener('click', () => { frozen = !frozen; syncButtons(); });
  $('btn-sonify').addEventListener('click', () => {
    audio.isSonifying() ? audio.stopSonify() : audio.startSonify();
    syncButtons();
  });
  $('band-selector').addEventListener('click', e => {
    const b = e.target.closest('.band-btn');
    if (!b) return;
    selBand = b.dataset.band;
    peakDb = -Infinity;
    refreshBandUi();
  });
  $('btn-cap-a').addEventListener('click', () => {
    capA = currentSelLevel();
    $('cap-a-val').textContent = capA !== null ? capA.toFixed(1) : '—';
    updateDelta();
  });
  $('btn-cap-b').addEventListener('click', () => {
    capB = currentSelLevel();
    $('cap-b-val').textContent = capB !== null ? capB.toFixed(1) : '—';
    updateDelta();
  });
  refreshBandUi();
  syncButtons();
}

function currentSelLevel() {
  const fd = audio.spectrum();
  if (!fd || !selBand) return null;
  const r = bandRange(selBand);
  return audio.bandDb(fd, r.lo, r.hi);
}

function updateDelta() {
  if (capA !== null && capB !== null) {
    const d = capB - capA;
    $('cap-delta').textContent = (d > 0 ? '+' : '') + d.toFixed(1) + ' dB';
  }
}
