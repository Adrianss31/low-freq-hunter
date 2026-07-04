// Configurazione: default, persistenza, helper bande.
'use strict';

export const BAND_KEYS = ['A', 'B', 'C'];
export const BAND_COLORS = { A: '#ffaa00', B: '#00d4aa', C: '#9988ff' };

export const DEFAULTS = {
  bands: {
    A: { enabled: true,  center: 50,  width: 5,  thr: -55 },
    B: { enabled: true,  center: 100, width: 5,  thr: -55 },
    C: { enabled: false, center: 150, width: 20, thr: -55 },
  },
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

function merge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object') {
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
    cfg = merge(structuredClone(DEFAULTS), JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
  } catch {
    cfg = structuredClone(DEFAULTS);
  }
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

export function bandRange(k) {
  const b = cfg.bands[k];
  return { lo: Math.max(1, b.center - b.width), hi: b.center + b.width };
}

export function bandLabel(k) {
  const b = cfg.bands[k];
  return `${k} · ${b.center} Hz ±${b.width}`;
}

export function enabledBands() {
  return BAND_KEYS.filter(k => cfg.bands[k].enabled);
}

// Snapshot immutabile della config da salvare dentro la sessione (prova di
// quali parametri erano attivi durante la misura).
export function cfgSnapshot() {
  return structuredClone(cfg);
}
