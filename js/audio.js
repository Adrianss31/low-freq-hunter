// Motore audio: microfono, analisi FFT, livelli di banda, sonificazione Geiger.
//
// Scelte deliberate:
// - AudioContext a sample rate nativo (niente {sampleRate:8000}: Firefox rifiuta
//   di collegare un MediaStream a un context con rate diverso, e iOS lo ignora).
//   La risoluzione arriva dall'FFT grande: 32768 punti a 48 kHz = ~1.46 Hz/bin.
// - AGC/echo/noise suppression disattivati: servono livelli non manipolati.
// - Un oscillatore quasi muto tiene "udibile" la pagina: alcuni browser
//   riducono il throttling dei tab che riproducono audio.
'use strict';

import { cfg } from './config.js';

let ctx = null, analyser = null, source = null, stream = null;
let keepAliveOsc = null, freqData = null;
let running = false;
let stateChangeCb = null;

export function isRunning() { return running; }
export function sampleRate() { return ctx ? ctx.sampleRate : 48000; }
export function binHz() { return ctx && analyser ? ctx.sampleRate / analyser.fftSize : 48000 / cfg.fftSize; }
export function getStream() { return stream; }
export function audioState() { return ctx ? ctx.state : 'closed'; }
export function onStateChange(cb) { stateChangeCb = cb; }

export async function startAudio(smoothing) {
  if (running && ctx && analyser) {
    analyser.smoothingTimeConstant = smoothing;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    return { ok: true };
  }
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return { ok: false, error: 'Serve HTTPS per accedere al microfono.' };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: 'Browser non supportato (niente getUserMedia).' };
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    });
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
    return { ok: false, error: denied ? 'Permesso microfono negato: abilitalo nelle impostazioni del browser.' : 'Errore microfono: ' + err.message };
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  analyser = ctx.createAnalyser();
  setFftSize(cfg.fftSize);
  analyser.smoothingTimeConstant = smoothing;

  source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);

  keepAliveOsc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = 0.0001;
  keepAliveOsc.frequency.value = 25;
  keepAliveOsc.connect(g).connect(ctx.destination);
  keepAliveOsc.start();

  ctx.onstatechange = () => { if (stateChangeCb) stateChangeCb(ctx.state); };
  running = true;
  return { ok: true };
}

export function setFftSize(size) {
  if (!analyser) return;
  // Alcuni browser limitano fftSize: dimezza finché non viene accettato.
  let s = size;
  while (s >= 2048) {
    try { analyser.fftSize = s; break; } catch { s = s / 2; }
  }
  freqData = new Float32Array(analyser.frequencyBinCount);
}

export function setSmoothing(v) { if (analyser) analyser.smoothingTimeConstant = v; }

export function stopAudio() {
  running = false;
  stopSonify();
  try { keepAliveOsc?.stop(); } catch { /* già fermo */ }
  keepAliveOsc = null;
  source?.disconnect(); source = null;
  analyser = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  ctx?.close().catch(() => {}); ctx = null;
  freqData = null;
}

// Spettro corrente in dBFS per bin. Ritorna null se il motore non è attivo.
export function spectrum() {
  if (!analyser || !freqData) return null;
  analyser.getFloatFrequencyData(freqData);
  return freqData;
}

// Potenza integrata di banda in dBFS (somma delle potenze lineari dei bin).
export function bandDb(fd, lo, hi) {
  const bh = binHz();
  const i0 = Math.max(0, Math.round(lo / bh));
  const i1 = Math.min(fd.length - 1, Math.round(hi / bh));
  let p = 0;
  for (let i = i0; i <= i1; i++) p += Math.pow(10, fd[i] / 10);
  return 10 * Math.log10(p + 1e-12);
}

export function dominantHz(fd, lo, hi) {
  const bh = binHz();
  const i0 = Math.max(1, Math.round(lo / bh));
  const i1 = Math.min(fd.length - 1, Math.round(hi / bh));
  let maxV = -Infinity, maxI = i0;
  for (let i = i0; i <= i1; i++) if (fd[i] > maxV) { maxV = fd[i]; maxI = i; }
  return { hz: maxI * bh, db: maxV };
}

// ── Sonificazione stile contatore Geiger ────────────────────────────────────
let sonifyOn = false, geigerTimer = null, geigerLevel = -120;

function playClick() {
  if (!ctx) return;
  const n = Math.floor(ctx.sampleRate * 0.003);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.25));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  const norm = Math.max(0, Math.min(1, (geigerLevel + 120) / 80));
  g.gain.value = 0.3 + norm * 0.65;
  src.connect(g).connect(ctx.destination);
  src.start();
}

function geigerSchedule() {
  if (!sonifyOn) return;
  const norm = Math.max(0, Math.min(1, (geigerLevel + 120) / 80));
  const rate = norm * norm * 30; // click/s, scala quadratica
  if (rate > 0.3) {
    playClick();
    geigerTimer = setTimeout(geigerSchedule, (1000 / rate) * (0.4 + Math.random() * 1.2));
  } else {
    geigerTimer = setTimeout(geigerSchedule, 400);
  }
}

export function startSonify() { if (!sonifyOn) { sonifyOn = true; geigerSchedule(); } }
export function stopSonify() { sonifyOn = false; if (geigerTimer) { clearTimeout(geigerTimer); geigerTimer = null; } }
export function setSonifyLevel(db) { geigerLevel = db; }
export function isSonifying() { return sonifyOn; }
