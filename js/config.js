// Configurazione: default, persistenza, helper bande.
//
// Le bande sono un elenco dinamico (min 1, max MAX_BANDS): l'utente può
// aggiungerne e rimuoverne a piacere. Ogni banda ha un id-lettera stabile
// (A, B, C, …) che determina anche il colore e compare negli eventi salvati.
'use strict';

export const MAX_BANDS = 8;

const PALETTE = ['#ffaa00', '#00d4aa', '#9988ff', '#ff6688', '#55aaff', '#aaee44', '#ff8844', '#44ddee'];

export function bandColor(id) {
  const i = String(id).charCodeAt(0) - 65;
  return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

export const DEFAULTS = {
  bands: [
    { id: 'A', enabled: true, center: 50, width: 5, thr: -55 },
    { id: 'B', enabled: true, center: 100, width: 5, thr: -55 },
  ],
  minOnS: 10,          // secondi sopra soglia per aprire un evento
  minOffS: 15,         // secondi sotto soglia per chiuderlo
  hystDb: 3,           // isteresi: soglia OFF = soglia ON - hystDb
  fftSize: 32768,      // ~1.5 Hz/bin a 48 kHz
  smoothLive: 0.5,
  smoothNight: 0.3,
  specXMax: 250,       // asse X spettro live (Hz)
  sonify: false,
  clipsEnabled: false, // registra clip audio all'inizio di ogni evento
  clipSeconds: 20,
  clipsMax: 12,
};

const LS_KEY = 'lfh-cfg';
const clamp = (v, lo, hi, fb) => { const n = +v; return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb; };

// Accetta sia il formato nuovo (array) sia quello storico ({A:{...},B:{...}})
// e restituisce sempre un array valido di bande.
export function normalizeBands(raw) {
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object') {
    arr = Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)).map(([id, b]) => ({ id, ...b }));
  } else arr = [];
  const seen = new Set();
  const out = [];
  for (const b of arr) {
    if (!b || typeof b !== 'object') continue;
    const id = typeof b.id === 'string' && /^[A-Z]$/.test(b.id) && !seen.has(b.id) ? b.id : nextFreeId(seen);
    if (!id) break;
    seen.add(id);
    out.push({
      id,
      enabled: b.enabled !== false,
      center: clamp(b.center, 10, 2000, 100),
      width: clamp(b.width, 1, 200, 5),
      thr: clamp(b.thr, -100, -10, -55),
    });
    if (out.length >= MAX_BANDS) break;
  }
  if (!out.length) out.push(...structuredClone(DEFAULTS.bands));
  return out;
}

function nextFreeId(taken) {
  for (let i = 0; i < 26; i++) {
    const id = String.fromCharCode(65 + i);
    if (!taken.has(id)) return id;
  }
  return null;
}

function merge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], over[k]);
    } else if (over[k] !== undefined) {
      out[k] = over[k];
    }
  }
  return out;
}

export let cfg = structuredClone(DEFAULTS);
loadCfg();

export function loadCfg() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (saved.bands !== undefined) saved.bands = normalizeBands(saved.bands);
    cfg = merge(structuredClone(DEFAULTS), saved);
  } catch {
    cfg = structuredClone(DEFAULTS);
  }
  cfg.bands = normalizeBands(cfg.bands);
  return cfg;
}

export function saveCfg() {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export function resetCfg() {
  cfg = structuredClone(DEFAULTS);
  saveCfg();
  return cfg;
}

export function getBand(id) {
  return cfg.bands.find(b => b.id === id) || null;
}

export function bandRange(id) {
  const b = getBand(id);
  return { lo: Math.max(1, b.center - b.width), hi: b.center + b.width };
}

export function bandLabel(id) {
  const b = getBand(id);
  return b ? `${b.id} · ${b.center} Hz ±${b.width}` : String(id);
}

// Id delle bande attive, nell'ordine dell'elenco.
export function enabledBands() {
  return cfg.bands.filter(b => b.enabled).map(b => b.id);
}

export function addBand() {
  if (cfg.bands.length >= MAX_BANDS) return null;
  const id = nextFreeId(new Set(cfg.bands.map(b => b.id)));
  if (!id) return null;
  const band = { id, enabled: true, center: 150, width: 10, thr: -55 };
  cfg.bands.push(band);
  return band;
}

export function removeBand(id) {
  if (cfg.bands.length <= 1) return false;
  const i = cfg.bands.findIndex(b => b.id === id);
  if (i < 0) return false;
  cfg.bands.splice(i, 1);
  return true;
}

// Snapshot immutabile della config da salvare dentro la sessione (prova di
// quali parametri erano attivi durante la misura).
export function cfgSnapshot() {
  return structuredClone(cfg);
}
