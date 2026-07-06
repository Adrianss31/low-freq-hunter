// UI della modalità notturna: pannelli, strisce presenza, blackout, marker.
// Le righe per-banda (meter e strisce) sono generate dinamicamente
// dall'elenco corrente delle bande attive.
'use strict';

import { cfg, enabledBands, bandColor, getBand } from './config.js';
import * as audio from './audio.js';
import * as night from './night.js';
import { showToast, fmtDur, fmtClock, drawWaterfall, setupCanvas } from './ui.js';
import { stopLive, liveRunning } from './live.js';

const $ = id => document.getElementById(id);
let rowsSig = ''; // firma dell'elenco bande per cui sono state costruite le righe

function setPanels(on) {
  $('btn-night-start').style.display = on ? 'none' : '';
  $('btn-night-stop').style.display = on ? '' : 'none';
  $('night-rec-row').style.display = on ? 'block' : 'none';
  $('night-idle-msg').style.display = on ? 'none' : 'block';
  ['night-wf-panel', 'night-strips-panel', 'night-now-panel'].forEach(id => { $(id).style.display = on ? '' : 'none'; });
  $('btn-blackout').style.display = on ? '' : 'none';
  $('btn-marker').style.display = on ? '' : 'none';
  if (!on) $('blackout').style.display = 'none';
}

// Ricostruisce le righe per-banda se l'elenco delle bande attive è cambiato.
function syncBandRows() {
  const ids = enabledBands();
  const sig = ids.join(',');
  if (sig === rowsSig) return;
  rowsSig = sig;
  $('nm-rows').innerHTML = ids.map(k => {
    const c = bandColor(k);
    return `<div class="now-meter" id="nm-row-${k}">
      <span class="nm-label">${k}</span>
      <div class="nm-track"><div class="nm-fill" id="nm-fill-${k}" style="background:${c}"></div><div class="nm-thr" id="nm-thr-${k}"></div></div>
      <span class="nm-status mono" id="nm-status-${k}">—</span>
    </div>`;
  }).join('');
  $('ps-rows').innerHTML = ids.map(k =>
    `<div class="presence-strip" id="ps-row-${k}"><span class="ps-label">${k}</span><div class="ps-track" id="ps-${k}"></div></div>`
  ).join('');
}

// Aggiornamento 1/s: waterfall, strisce, contatori.
function perSecondUi() {
  if (!night.nightRunning) return;
  syncBandRows();
  drawNightWf();
  drawStrips();
}

// Aggiornamento per-tick (4/s): meter istantanei e frequenza dominante.
function perTickUi(lv, fd) {
  const dom = audio.dominantHz(fd, night.WF_FMIN, night.WF_FMAX);
  $('now-hz').textContent = dom.hz.toFixed(1);
  const ids = enabledBands();
  const active = ids.filter(k => night.isBandActive(k));
  const st = $('now-status');
  if (active.length) {
    const since = Math.min(...active.map(k => night.activeSince(k)));
    st.textContent = '● Segnale presente · ' + fmtDur(Date.now() / 1000 - since);
    st.style.color = 'var(--red)';
  } else {
    st.textContent = 'silenzio';
    st.style.color = '#555';
  }
  for (const k of ids) {
    const fill = $('nm-fill-' + k);
    if (!fill) continue; // righe non ancora sincronizzate
    const db = lv[k] ?? -120;
    const pct = Math.max(0, Math.min(100, (db + 120) / 120 * 100));
    const thrPct = Math.max(0, Math.min(100, (getBand(k).thr + 120) / 120 * 100));
    fill.style.width = pct + '%';
    $('nm-thr-' + k).style.left = thrPct + '%';
    const sm = night.smState(k);
    const el = $('nm-status-' + k);
    if (night.isBandActive(k)) {
      el.textContent = '● ' + fmtDur(Date.now() / 1000 - night.activeSince(k));
      el.style.color = 'var(--red)';
    } else if (sm && sm.state === 1) { el.textContent = '↑ sale'; el.style.color = 'var(--amber)'; }
    else if (sm && sm.state === 3) { el.textContent = '↓ scende'; el.style.color = 'var(--amber)'; }
    else { el.textContent = db.toFixed(0); el.style.color = '#555'; }
  }
}

function drawNightWf() {
  const { ctx, W, H } = setupCanvas($('night-wf-canvas'), 72);
  const guides = enabledBands().map(k => ({ hz: getBand(k).center, color: bandColor(k) + '88' }));
  drawWaterfall(ctx, W, H, night.sessionSlices, {
    guides,
    startMs: night.session?.startedAt, endMs: Date.now(),
  });
}

function drawStrips() {
  if (!night.session) return;
  const tMin = night.session.startedAt / 1000;
  const tMax = Date.now() / 1000;
  const span = Math.max(tMax - tMin, 1);
  const evs = night.sessionEvents();
  const ids = enabledBands();
  for (const k of ids) {
    const track = $('ps-' + k);
    if (!track) continue;
    track.innerHTML = '';
    const bandEvs = evs.filter(e => e.band === k).map(e => ({ s: e.startT, e: e.endT }));
    const since = night.activeSince(k);
    if (since !== null) bandEvs.push({ s: since, e: tMax });
    for (const ev of bandEvs) {
      const bar = document.createElement('div');
      bar.className = 'ps-bar';
      bar.style.cssText = `left:${((ev.s - tMin) / span * 100).toFixed(2)}%;width:${Math.max((ev.e - ev.s) / span * 100, 0.4).toFixed(2)}%;background:${bandColor(k)}`;
      track.appendChild(bar);
    }
  }
  // marker come tacche bianche sulla prima striscia visibile
  const firstK = ids[0];
  if (firstK && $('ps-' + firstK)) {
    const track = $('ps-' + firstK);
    for (const m of night.sessionMarkers()) {
      const tick = document.createElement('div');
      tick.className = 'ps-marker';
      tick.style.left = ((m.t - tMin) / span * 100).toFixed(2) + '%';
      track.appendChild(tick);
    }
  }
  $('n-events').textContent = evs.filter(e => e.band !== 'gap').length;
}

// ── Blackout: tap = marker, pressione lunga = esci ──────────────────────────
async function enterBlackout() {
  const el = document.documentElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  } catch { /* fullscreen non concesso: il blackout funziona comunque */ }
  $('blackout').style.display = '';
}

async function exitBlackout() {
  $('blackout').style.display = 'none';
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
    }
  } catch { /* ok */ }
}

function flashBlackoutHint(text, ms = 1800) {
  const hint = $('blackout-hint');
  hint.textContent = text;
  hint.style.display = '';
  clearTimeout(flashBlackoutHint._t);
  flashBlackoutHint._t = setTimeout(() => { hint.style.display = 'none'; }, ms);
}

export function initNightUi() {
  night.setUiCallbacks(perSecondUi, perTickUi);

  $('btn-night-start').addEventListener('click', async () => {
    if (liveRunning) stopLive(true); // tieni vivo l'AudioContext
    const ok = await night.startNight();
    if (ok) { rowsSig = ''; syncBandRows(); setPanels(true); drawNightWf(); drawStrips(); }
  });
  $('btn-night-stop').addEventListener('click', async () => {
    await night.stopNight();
    setPanels(false);
    if (!liveRunning) audio.stopAudio();
  });
  $('btn-marker').addEventListener('click', () => {
    if (night.addMarker('button')) showToast('▲ Marker registrato ' + fmtClock(Date.now()));
  });
  $('btn-blackout').addEventListener('click', enterBlackout);

  // Blackout: tap breve = marker, pressione ≥1 s = esci.
  const bo = $('blackout');
  let pressT = 0, pressTimer = null;
  bo.addEventListener('pointerdown', () => {
    pressT = Date.now();
    pressTimer = setTimeout(() => { pressTimer = null; exitBlackout(); }, 1000);
  });
  bo.addEventListener('pointerup', () => {
    if (!pressTimer) return; // pressione lunga già gestita
    clearTimeout(pressTimer); pressTimer = null;
    if (Date.now() - pressT < 600) {
      night.addMarker('blackout');
      flashBlackoutHint('▲ marker salvato · tieni premuto per uscire');
    }
  });
  bo.addEventListener('pointercancel', () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) $('blackout').style.display = 'none';
  });

  // Orologio + durata
  setInterval(() => {
    $('night-clock').textContent = fmtClock(Date.now());
    if (night.nightRunning && night.session) {
      const el = Math.floor((Date.now() - night.session.startedAt) / 1000);
      const h = Math.floor(el / 3600), m = Math.floor((el % 3600) / 60), s = el % 60;
      $('night-elapsed').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
  }, 1000);

  // Background / interruzioni
  document.addEventListener('visibilitychange', async () => {
    const warn = $('night-bg-warn');
    if (document.visibilityState === 'visible') {
      warn.style.display = 'none';
      if (night.nightRunning) await night.keepAwake();
    } else if (night.nightRunning) {
      warn.style.display = 'block';
      night.flush();
    }
  });
  window.addEventListener('pagehide', () => { if (night.nightRunning) night.flush(); });

  setPanels(false);
}
