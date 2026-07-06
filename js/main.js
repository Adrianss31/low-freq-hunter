// Bootstrap: navigazione, impostazioni, recovery, service worker, batteria.
'use strict';

import { cfg, saveCfg, resetCfg, loadCfg, getBand, addBand, removeBand, bandColor, MAX_BANDS } from './config.js';
import * as audio from './audio.js';
import { openDb, storageEstimate } from './db.js';
import { showToast } from './ui.js';
import { initLive, refreshBandUi } from './live.js';
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

// ── Card bande (dinamiche) ──────────────────────────────────────────────────
function renderBandCards() {
  $('band-cards').innerHTML = cfg.bands.map(b => {
    const c = bandColor(b.id);
    return `
    <div class="band-card${b.enabled ? '' : ' disabled'}" data-band="${b.id}" style="--bc:${c}">
      <div class="band-card-head">
        <div class="band-dot"></div>
        <div class="band-id">${b.id}</div>
        <div class="band-head-name">${b.center} Hz ±${b.width}</div>
        <div class="toggle${b.enabled ? ' on' : ''}" data-btoggle="${b.id}" title="Attiva/disattiva"></div>
        ${cfg.bands.length > 1 ? `<button class="band-del" data-bdel="${b.id}" title="Elimina banda">✕</button>` : ''}
      </div>
      <div class="band-card-body">
        <div class="band-param"><span class="band-param-label">Centro</span>
          <div class="stepper"><button data-step="s-${b.id}-center" data-d="-1">−</button><input type="number" id="s-${b.id}-center" data-band="${b.id}" data-field="center" min="10" max="2000" step="1" value="${b.center}"><span class="stepper-unit">Hz</span><button data-step="s-${b.id}-center" data-d="1">+</button></div></div>
        <div class="band-param"><span class="band-param-label">Larghezza ±</span>
          <div class="stepper"><button data-step="s-${b.id}-width" data-d="-1">−</button><input type="number" id="s-${b.id}-width" data-band="${b.id}" data-field="width" min="1" max="200" step="1" value="${b.width}"><span class="stepper-unit">Hz</span><button data-step="s-${b.id}-width" data-d="1">+</button></div></div>
        <div class="thr-block">
          <div class="thr-head"><span class="thr-head-label">Soglia trigger</span><span><span class="thr-head-val">${b.thr}</span><span class="thr-head-unit"> dBFS</span></span></div>
          <input type="range" data-band="${b.id}" data-field="thr" class="thr-sl" min="-100" max="-10" step="1" value="${b.thr}">
          <div class="thr-hints"><span>← più sensibile</span><span>meno sensibile →</span></div>
        </div>
      </div>
    </div>`;
  }).join('');
  $('btn-add-band').style.display = cfg.bands.length >= MAX_BANDS ? 'none' : '';
}

// ── Impostazioni ────────────────────────────────────────────────────────────
function populateSettings() {
  renderBandCards();
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

const LIMITS = { center: [10, 2000], width: [1, 200], thr: [-100, -10] };

function collectSettings() {
  document.querySelectorAll('#band-cards input[data-band]').forEach(inp => {
    const b = getBand(inp.dataset.band);
    if (!b) return;
    const f = inp.dataset.field;
    const [lo, hi] = LIMITS[f];
    b[f] = clampNum(inp.value, lo, hi, b[f]);
  });
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
  // Aggiorna le etichette delle card senza ricostruirle (per non perdere il focus)
  document.querySelectorAll('#band-cards .band-card').forEach(card => {
    const b = getBand(card.dataset.band);
    if (!b) return;
    card.querySelector('.band-head-name').textContent = `${b.center} Hz ±${b.width}`;
    card.querySelector('.thr-head-val').textContent = b.thr;
  });
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
  // Stepper ± (delegato: funziona anche sulle card generate dopo)
  $('tab-settings').addEventListener('click', e => {
    const btn = e.target.closest('button[data-step]');
    if (!btn) return;
    const inp = $(btn.dataset.step);
    if (!inp) return;
    const step = +inp.step || 1;
    inp.value = +(+inp.value + (+btn.dataset.d * step)).toFixed(4);
    applyAndSave();
  });

  // Ogni input (statico o dinamico): aggiorna eventuale etichetta e salva
  const labelMap = {
    's-minon': 's-minon-val', 's-minoff': 's-minoff-val',
    's-smooth-live': 's-smooth-live-val', 's-smooth-night': 's-smooth-night-val',
  };
  $('tab-settings').addEventListener('input', e => {
    const t = e.target;
    if (t.tagName !== 'INPUT') return;
    if (labelMap[t.id]) $(labelMap[t.id]).textContent = t.value;
    applyAndSave();
  });
  $('tab-settings').addEventListener('change', e => {
    if (e.target.tagName === 'INPUT') applyAndSave();
  });

  // Toggle attiva/disattiva ed eliminazione banda (delegati sulle card)
  $('band-cards').addEventListener('click', e => {
    const tog = e.target.closest('[data-btoggle]');
    if (tog) {
      const b = getBand(tog.dataset.btoggle);
      if (b) { b.enabled = !b.enabled; renderBandCards(); applyAndSave(); }
      return;
    }
    const del = e.target.closest('[data-bdel]');
    if (del) {
      const id = del.dataset.bdel;
      if (confirm(`Eliminare la banda ${id}?`)) {
        removeBand(id);
        renderBandCards();
        applyAndSave();
      }
    }
  });

  $('btn-add-band').addEventListener('click', () => {
    const b = addBand();
    if (!b) { showToast(`Massimo ${MAX_BANDS} bande.`); return; }
    renderBandCards();
    applyAndSave();
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
