// Modalità notturna: sessione di log, macchine a stati per banda, storage,
// waterfall persistito, marker, gap di monitoraggio, clip audio opzionali.
//
// Il loop gira su setInterval (non requestAnimationFrame): con lo schermo in
// blackout alcuni browser sospendono i rAF, mentre un timer continua finché la
// pagina è in primo piano con wake lock. Se comunque il monitoraggio si
// interrompe (>5 s tra due tick), il buco viene registrato come "gap": per un
// dato che vuole essere una prova, sapere QUANDO non si stava misurando conta
// quanto la misura stessa.
'use strict';

import { cfg, cfgSnapshot, enabledBands, bandRange, BAND_KEYS, BAND_COLORS } from './config.js';
import * as audio from './audio.js';
import { dbPut, dbBatch, dbAll, uuid, requestPersistentStorage } from './db.js';
import { showToast, fmtDur, fmtClock } from './ui.js';

const TICK_MS = 250;
const SLICE_S = 30;                       // una colonna waterfall ogni 30 s
export const WF_FMIN = 20, WF_FMAX = 200, WF_NBINS = 64;
export const Q_MIN = -110, Q_MAX = -20;   // range di quantizzazione slice (dBFS)
const GAP_S = 5;                          // buco di monitoraggio oltre questa soglia

export let nightRunning = false;
export let session = null;

let tickTimer = null, lastTickMs = 0;
let sms = {};                 // macchina a stati per banda
let events = [];              // eventi della sessione corrente (inclusi gap)
let markers = [];
let sampleBuf = [], sliceBuf = [], lastFlush = 0;
let secAcc = null, curSec = 0;           // accumulatore del secondo corrente
let sliceAcc = null, sliceCount = 0, lastSliceT = 0;
let wakeLock = null;
let clipCount = 0, recorder = null;
let audioInterruptions = 0;
export let sessionSlices = [];           // slice in memoria per il render live

const S = { IDLE: 0, RISING: 1, ACTIVE: 2, FALLING: 3 };

function newSM(band) {
  return { band, state: S.IDLE, riseT: 0, fallT: 0, evStart: null, peak: -Infinity, pSum: 0, pN: 0 };
}

export function smState(k) { return sms[k] || null; }
export function activeSince(k) {
  const sm = sms[k];
  return sm && sm.state === S.ACTIVE ? sm.evStart : null;
}
export function isBandActive(k) { return sms[k]?.state === S.ACTIVE; }
export function sessionEvents() { return events; }
export function sessionMarkers() { return markers; }

// ── Macchina a stati per banda ──────────────────────────────────────────────
function smStep(sm, level, t) {
  const thrOn = cfg.bands[sm.band].thr;
  const thrOff = thrOn - cfg.hystDb;
  switch (sm.state) {
    case S.IDLE:
      if (level >= thrOn) { sm.state = S.RISING; sm.riseT = t; }
      break;
    case S.RISING:
      if (level < thrOn) { sm.state = S.IDLE; }
      else if (t - sm.riseT >= cfg.minOnS) {
        sm.state = S.ACTIVE; sm.evStart = sm.riseT;
        sm.peak = level; sm.pSum = Math.pow(10, level / 10); sm.pN = 1;
        onEventStart(sm.band, sm.riseT);
      }
      break;
    case S.ACTIVE:
      if (level > sm.peak) sm.peak = level;
      sm.pSum += Math.pow(10, level / 10); sm.pN++;
      if (level < thrOff) { sm.state = S.FALLING; sm.fallT = t; }
      break;
    case S.FALLING:
      if (level >= thrOff) { sm.state = S.ACTIVE; }
      else if (t - sm.fallT >= cfg.minOffS) {
        closeEvent(sm, sm.fallT);
      }
      break;
  }
}

function closeEvent(sm, endT) {
  const avgDb = sm.pN ? 10 * Math.log10(sm.pSum / sm.pN + 1e-12) : null;
  saveEvent({
    id: uuid(), sessionId: session.id, band: sm.band,
    startT: Math.floor(sm.evStart), endT: Math.floor(endT),
    durationS: Math.floor(endT - sm.evStart),
    peakDb: sm.peak, avgDb,
  });
  sm.state = S.IDLE; sm.evStart = null; sm.peak = -Infinity; sm.pSum = 0; sm.pN = 0;
}

function saveEvent(ev) {
  events.push(ev);
  dbPut('events', ev).catch(() => {});
  session.eventsCount = events.filter(e => e.band !== 'gap').length;
  dbPut('sessions', session).catch(() => {});
  if (onUiUpdate) onUiUpdate();
}

function onEventStart(band, startT) {
  maybeRecordClip(band, startT);
}

// ── Gap di monitoraggio ─────────────────────────────────────────────────────
function handleGap(fromS, toS) {
  // Durante il buco non sappiamo nulla: chiudi gli eventi aperti all'inizio
  // del gap e riparti da zero, poi registra il gap stesso.
  for (const k of BAND_KEYS) {
    const sm = sms[k];
    if (sm && sm.evStart !== null && (sm.state === S.ACTIVE || sm.state === S.FALLING)) {
      closeEvent(sm, fromS);
    } else if (sm) {
      sm.state = S.IDLE;
    }
  }
  saveEvent({
    id: uuid(), sessionId: session.id, band: 'gap',
    startT: Math.floor(fromS), endT: Math.floor(toS),
    durationS: Math.floor(toS - fromS), peakDb: null, avgDb: null,
  });
}

// ── Marker ──────────────────────────────────────────────────────────────────
export function addMarker(origin) {
  if (!nightRunning) return null;
  const m = { id: uuid(), sessionId: session.id, t: Math.floor(Date.now() / 1000), origin };
  markers.push(m);
  dbPut('markers', m).catch(() => {});
  session.markersCount = markers.length;
  dbPut('sessions', session).catch(() => {});
  if (onUiUpdate) onUiUpdate();
  return m;
}

// ── Clip audio (opzionali) ──────────────────────────────────────────────────
function pickMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function maybeRecordClip(band, startT) {
  if (!cfg.clipsEnabled || recorder || clipCount >= cfg.clipsMax) return;
  const stream = audio.getStream();
  const mime = pickMime();
  if (!stream || mime === null) return;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch { recorder = null; return; }
  const chunks = [];
  const sessId = session.id;
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder?.mimeType || mime || 'audio/webm' });
    recorder = null;
    if (blob.size) {
      dbPut('clips', { id: uuid(), sessionId: sessId, band, t: Math.floor(startT), mime: blob.type, blob })
        .catch(() => {});
    }
  };
  recorder.start();
  clipCount++;
  setTimeout(() => { try { recorder?.stop(); } catch { recorder = null; } }, cfg.clipSeconds * 1000);
}

// ── Waterfall ───────────────────────────────────────────────────────────────
function accumulateSlice(fd) {
  const bh = audio.binHz();
  if (!sliceAcc) sliceAcc = new Float64Array(WF_NBINS);
  for (let b = 0; b < WF_NBINS; b++) {
    const fL = WF_FMIN + (b / WF_NBINS) * (WF_FMAX - WF_FMIN);
    const fH = WF_FMIN + ((b + 1) / WF_NBINS) * (WF_FMAX - WF_FMIN);
    const i0 = Math.max(0, Math.round(fL / bh));
    const i1 = Math.min(fd.length - 1, Math.round(fH / bh));
    let p = 0, n = 0;
    for (let i = i0; i <= i1; i++) { p += Math.pow(10, fd[i] / 10); n++; }
    if (n) sliceAcc[b] += p / n;
  }
  sliceCount++;
}

function emitSlice(t) {
  if (!sliceAcc || !sliceCount) return;
  const bins = new Uint8Array(WF_NBINS);
  for (let b = 0; b < WF_NBINS; b++) {
    const db = 10 * Math.log10(sliceAcc[b] / sliceCount + 1e-12);
    bins[b] = Math.max(0, Math.min(255, Math.round((db - Q_MIN) / (Q_MAX - Q_MIN) * 255)));
  }
  const slice = { sessionId: session.id, t: Math.floor(t), bins };
  sessionSlices.push(slice);
  sliceBuf.push(slice);
  sliceAcc = null; sliceCount = 0;
}

// ── Loop di analisi ─────────────────────────────────────────────────────────
let onUiUpdate = null;   // callback UI (ridisegno pannelli), impostata da main
let onTickUpdate = null; // callback UI per-tick (meter istantanei)
export function setUiCallbacks(perSecond, perTick) { onUiUpdate = perSecond; onTickUpdate = perTick; }

function tick() {
  if (!nightRunning) return;
  const nowMs = Date.now();
  const nowS = nowMs / 1000;
  if (lastTickMs && nowMs - lastTickMs > GAP_S * 1000) {
    handleGap(lastTickMs / 1000, nowS);
    secAcc = null;
  }
  lastTickMs = nowMs;

  const fd = audio.spectrum();
  if (!fd) return;

  const lv = {};
  for (const k of enabledBands()) {
    const r = bandRange(k);
    lv[k] = audio.bandDb(fd, r.lo, r.hi);
  }
  const ref = audio.bandDb(fd, 20, 500);
  if (onTickUpdate) onTickUpdate(lv, fd);
  if (audio.isSonifying()) {
    audio.setSonifyLevel(Math.max(...enabledBands().map(k => lv[k]), -120));
  }

  accumulateSlice(fd);

  const sec = Math.floor(nowS);
  if (!secAcc) secAcc = { sec, p: {}, pRef: 0, n: 0 };
  if (sec === secAcc.sec) {
    for (const k of enabledBands()) secAcc.p[k] = (secAcc.p[k] || 0) + Math.pow(10, lv[k] / 10);
    secAcc.pRef += Math.pow(10, ref / 10);
    secAcc.n++;
    return;
  }

  // Secondo concluso: aggrega, fai avanzare le macchine a stati, salva.
  if (secAcc.n) {
    const t = secAcc.sec;
    const avg = {};
    for (const k of enabledBands()) avg[k] = 10 * Math.log10((secAcc.p[k] || 0) / secAcc.n + 1e-12);
    const avgRef = 10 * Math.log10(secAcc.pRef / secAcc.n + 1e-12);
    const dom = audio.dominantHz(fd, WF_FMIN, WF_FMAX);
    for (const k of enabledBands()) smStep(sms[k], avg[k], t);
    sampleBuf.push({
      sessionId: session.id, t,
      a: avg.A ?? null, b: avg.B ?? null, c: avg.C ?? null,
      ref: avgRef, domHz: Math.round(dom.hz * 10) / 10,
    });
    if (t - lastSliceT >= SLICE_S) { emitSlice(t); lastSliceT = t; }
    session.lastT = t;
    if (onUiUpdate) onUiUpdate();
  }
  secAcc = { sec, p: {}, pRef: 0, n: 0 };
  for (const k of enabledBands()) secAcc.p[k] = Math.pow(10, lv[k] / 10);
  secAcc.pRef = Math.pow(10, ref / 10);
  secAcc.n = 1;

  if (nowMs - lastFlush > 10000 || sampleBuf.length >= 20) flush();
}

export function flush() {
  lastFlush = Date.now();
  if (sampleBuf.length) {
    const buf = sampleBuf.splice(0);
    dbBatch('samples', buf).catch(err => {
      if (err?.name === 'QuotaExceededError') showToast('⚠ Storage pieno! Esporta o elimina sessioni vecchie.', 5000);
    });
  }
  if (sliceBuf.length) dbBatch('slices', sliceBuf.splice(0)).catch(() => {});
  if (session) dbPut('sessions', session).catch(() => {});
}

// ── Wake lock ───────────────────────────────────────────────────────────────
export async function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* negato */ }
}

// ── Avvio / stop sessione ───────────────────────────────────────────────────
export async function startNight() {
  if (nightRunning) return false;
  const res = await audio.startAudio(cfg.smoothNight);
  if (!res.ok) { showToast(res.error, 5000); return false; }
  await requestPersistentStorage();

  session = {
    id: uuid(),
    label: `Notte ${new Date().toLocaleDateString('it-IT')} ${fmtClock(Date.now())}`,
    startedAt: Date.now(), endedAt: null, lastT: Math.floor(Date.now() / 1000),
    sampleRate: audio.sampleRate(), binHz: audio.binHz(),
    cfg: cfgSnapshot(),
    eventsCount: 0, markersCount: 0, recovered: false,
    userAgent: navigator.userAgent,
  };
  await dbPut('sessions', session);

  sms = {}; for (const k of BAND_KEYS) sms[k] = newSM(k);
  events = []; markers = []; sampleBuf = []; sliceBuf = [];
  sessionSlices = []; sliceAcc = null; sliceCount = 0;
  secAcc = null; lastTickMs = 0; lastFlush = Date.now();
  lastSliceT = Math.floor(Date.now() / 1000);
  clipCount = 0; audioInterruptions = 0;

  audio.onStateChange(async state => {
    if (!nightRunning) return;
    if (state !== 'running') {
      audioInterruptions++;
      // Prova a ripartire subito: se non ci riesce il gap verrà registrato.
      setTimeout(() => audio.startAudio(cfg.smoothNight).catch(() => {}), 500);
    }
  });

  nightRunning = true;
  await keepAwake();
  tickTimer = setInterval(tick, TICK_MS);
  if (cfg.sonify) audio.startSonify();
  return true;
}

export async function stopNight() {
  if (!nightRunning) return;
  nightRunning = false;
  clearInterval(tickTimer); tickTimer = null;
  try { recorder?.stop(); } catch { /* già fermo */ }

  const endS = Date.now() / 1000;
  for (const k of BAND_KEYS) {
    const sm = sms[k];
    if (sm && sm.evStart !== null && (sm.state === S.ACTIVE || sm.state === S.FALLING)) {
      closeEvent(sm, endS);
    }
  }
  emitSlice(Math.floor(endS));
  flush();
  session.endedAt = Date.now();
  session.eventsCount = events.filter(e => e.band !== 'gap').length;
  session.audioInterruptions = audioInterruptions;
  await dbPut('sessions', session).catch(() => {});
  session = null;
  try { await wakeLock?.release(); } catch { /* già rilasciato */ } wakeLock = null;
  audio.stopSonify();
  showToast('Sessione salvata ✓');
}

// Sessioni rimaste aperte (crash, batteria, chiusura browser): chiudile
// usando l'ultimo campione salvato come orario di fine reale.
export async function recoverInterrupted() {
  const all = await dbAll('sessions');
  let n = 0;
  for (const s of all) {
    if (!s.endedAt && (!session || s.id !== session.id)) {
      s.endedAt = (s.lastT ? s.lastT * 1000 : s.startedAt);
      s.recovered = true;
      await dbPut('sessions', s);
      n++;
    }
  }
  return n;
}

export { BAND_COLORS };
