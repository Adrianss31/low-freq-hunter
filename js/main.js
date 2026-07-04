// Bootstrap: navigazione, impostazioni, recovery, service worker, batteria.
'use strict';

import { cfg, saveCfg, resetCfg, loadCfg, BAND_KEYS } from './config.js';
import * as audio from './audio.js';
import { openDb, storageEstimate } from './db.js';
import { showToast } from './ui.js';
import { initLive, refreshBandUi, liveRunning } from './live.js';
import { initNightUi } from './nightui.js';
import * as night from './night.js';
import * as sessions from './sessions.js';

const $ = id => document.getElementById(id);

// ── Tab ─────────────────────────────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-nav button').forEach(el => el.classList.remove('active'));
  $('tab-' + id)?.classList.add('active');
  document.querySelector(`.tab-nav button[data-tab="${id}"]`)?.classList.add('active');
  if (id === 'summary') { sessions.backToList(); }
  if (id === 'settings') { populateSettings(); updateStorageInfo(); }
}

// ── Impostazioni ────────────────────────────────────────────────────────────
function populateSettings() {
  for (const k of BAND_KEYS) {
    const b = cfg.bands[k];
    $(`s-${k}-center`).value = b.center;
    $(`s-${k}-width`).value = b.width;
    $(`s-${k}-thr`).value = b.thr;
    $(`s-${k}-thr-val`).textContent = b.thr;
    if (k === 'C') {
      $('s-C-enabled').classList.toggle('on', b.enabled);
      $('band-card-C').classList.toggle('disabled', !b.enabled);
    }
  }
  $('s-minon').value = cfg.minOnS; $('s-minon-val').textContent = cfg.minOnS;
  $('s-minoff').value = cfg.minOffS; $('s-minoff-val').textContent = cfg.minOffS;
  $('s-xmax').value = cfg.specXMax;
  $('s-smooth-live').value = cfg.smoothLive; $('s-smooth-live-val').textContent = cfg.smoothLive;
  $('s-smooth-night').value = cfg.smoothNight; $('s-smooth-night-val').textContent = cfg.smoothNight;
  $('s-sonify-toggle').classList.toggle('on', !!cfg.sonify);
  $('s-clips-toggle').classList.toggle('on', !!cfg.clipsEnabled);
  document.querySelectorAll('.chip[data-fft]').forEach(c => {
    const sz = +c.dataset.fft;
    c.classList.toggle('on', sz === cfg.fftSize);
    c.textContent = `${sz >= 32768 ? 'Alta' : sz >= 16384 ? 'Media' : 'Bassa'} · ${(audio.sampleRate() / sz).toFixed(1)} Hz/bin`;
  });
}

function collectSettings() {
  for (const k of BAND_KEYS) {
    const b = cfg.bands[k];
    b.center = clampNum($(`s-${k}-center`).value, 10, 2000, b.center);
    b.width = clampNum($(`s-${k}-width`).value, 1, 200, b.width);
    b.thr = clampNum($(`s-${k}-thr`).value, -100, -10, b.thr);
  }
  cfg.minOnS = clampNum($('s-minon').value, 1, 120, cfg.minOnS);
  cfg.minOffS = clampNum($('s-minoff').value, 1, 300, cfg.minOffS);
  cfg.specXMax = clampNum($('s-xmax').value, 100, 2000, cfg.specXMax);
  cfg.smoothLive = clampNum($('s-smooth-live').value, 0, 0.95, cfg.smoothLive);
  cfg.smoothNight = clampNum($('s-smooth-night').value, 0, 0.95, cfg.smoothNight);
}

function clampNum(v, lo, hi, fallback) {
  const n = +v;
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

let saveMsgTimer = null;
function applyAndSave() {
  collectSettings();
  saveCfg();
  if (audio.isRunning()) {
    audio.setSmoothing(night.nightRunning ? cfg.smoothNight : cfg.smoothLive);
  }
  refreshBandUi();
  for (const k of BAND_KEYS) $(`s-${k}-thr-val`).textContent = cfg.bands[k].thr;
  const msg = $('settings-saved-msg');
  msg.textContent = '✓ Salvate';
  msg.style.color = 'var(--accent)';
  clearTimeout(saveMsgTimer);
  saveMsgTimer = setTimeout(() => { msg.textContent = 'Le impostazioni si salvano automaticamente.'; msg.style.color = ''; }, 1500);
}

async function updateStorageInfo() {
  const est = await storageEstimate();
  const el = $('storage-info');
  if (!est) { el.textContent = ''; return; }
  const mb = x => (x / 1048576).toFixed(1);
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch { /* ok */ }
  el.textContent = `Spazio usato: ${mb(est.usage)} MB di ${mb(est.quota)} MB disponibili · storage ${persisted ? 'persistente ✓' : 'non persistente'}`;
}

function initSettingsUi() {
  // Stepper ±
  $('tab-settings').addEventListener('click', e => {
    const btn = e.target.closest('button[data-step]');
    if (!btn) return;
    const inp = $(btn.dataset.step);
    const step = +inp.step || 1;
    inp.value = +(+inp.value + (+btn.dataset.d * step)).toFixed(4);
    applyAndSave();
  });
  // Slider con display live
  [['s-A-thr', 's-A-thr-val'], ['s-B-thr', 's-B-thr-val'], ['s-C-thr', 's-C-thr-val'],
   ['s-minon', 's-minon-val'], ['s-minoff', 's-minoff-val'],
   ['s-smooth-live', 's-smooth-live-val'], ['s-smooth-night', 's-smooth-night-val']]
    .forEach(([sl, val]) => {
      $(sl).addEventListener('input', () => { $(val).textContent = $(sl).value; });
    });
  // Auto-save su ogni input
  document.querySelectorAll('#tab-settings input').forEach(el => {
    el.addEventListener('change', applyAndSave);
    if (el.type === 'range') el.addEventListener('input', applyAndSave);
  });
  // Chips FFT
  document.querySelectorAll('.chip[data-fft]').forEach(chip => {
    chip.addEventListener('click', () => {
      cfg.fftSize = +chip.dataset.fft;
      if (audio.isRunning()) audio.setFftSize(cfg.fftSize);
      populateSettings();
      applyAndSave();
    });
  });
  // Toggle
  $('s-C-enabled').addEventListener('click', function () {
    cfg.bands.C.enabled = !cfg.bands.C.enabled;
    this.classList.toggle('on', cfg.bands.C.enabled);
    $('band-card-C').classList.toggle('disabled', !cfg.bands.C.enabled);
    applyAndSave();
  });
  $('s-sonify-toggle').addEventListener('click', function () {
    cfg.sonify = !cfg.sonify;
    this.classList.toggle('on', cfg.sonify);
    applyAndSave();
  });
  $('s-clips-toggle').addEventListener('click', function () {
    cfg.clipsEnabled = !cfg.clipsEnabled;
    this.classList.toggle('on', cfg.clipsEnabled);
    applyAndSave();
  });
  $('btn-reset-cfg').addEventListener('click', () => {
    if (!confirm('Ripristinare tutte le impostazioni predefinite?')) return;
    resetCfg();
    populateSettings();
    refreshBandUi();
    showToast('Impostazioni ripristinate');
  });
}

// ── Batteria ────────────────────────────────────────────────────────────────
async function initBattery() {
  if (!navigator.getBattery) return;
  const bat = await navigator.getBattery().catch(() => null);
  if (!bat) return;
  const update = () => {
    const txt = Math.round(bat.level * 100) + '%' + (bat.charging ? ' ⚡' : '');
    $('night-battery').textContent = '🔋 ' + txt;
    if (night.nightRunning && !bat.charging && bat.level < 0.2) {
      showToast('⚠ Batteria sotto il 20% e non in carica.', 5000);
    }
  };
  update();
  bat.addEventListener('levelchange', update);
  bat.addEventListener('chargingchange', update);
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  loadCfg();
  await openDb();

  document.querySelectorAll('.tab-nav button').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  initLive();
  initNightUi();
  initSettingsUi();
  initBattery();

  $('btn-back').addEventListener('click', sessions.backToList);
  $('btn-csv-events').addEventListener('click', sessions.exportEventsCsv);
  $('btn-csv-samples').addEventListener('click', sessions.exportSamplesCsv);
  $('btn-json').addEventListener('click', sessions.exportJson);
  $('btn-report').addEventListener('click', sessions.exportReport);
  $('btn-del-session').addEventListener('click', sessions.deleteCurrent);

  const recovered = await night.recoverInterrupted();
  if (recovered) showToast(`${recovered} session${recovered > 1 ? 'i interrotte recuperate' : 'e interrotta recuperata'} (dati salvati fino all'ultimo campione).`, 5000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    showToast('⚠ Serve HTTPS (o localhost) per usare il microfono.', 6000);
  }
}

init();
