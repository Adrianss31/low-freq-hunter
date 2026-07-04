// Helper UI condivisi: toast, formattazione, colormap waterfall, download.
'use strict';

let toastTimer;
export function showToast(msg, dur = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

export function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('it-IT');
}

export function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${ss}s`;
  return `${ss}s`;
}

export function fmtIso(epochS) { return new Date(epochS * 1000).toISOString(); }

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}

// Colormap tipo "inferno" per i waterfall (v in [0,1]).
const STOPS = [[5, 10, 30], [30, 20, 90], [120, 30, 130], [210, 60, 120], [255, 140, 50], [255, 220, 100], [255, 255, 235]];
export function wfColor(v) {
  v = Math.max(0, Math.min(1, v));
  const t = v * (STOPS.length - 1), i = Math.floor(t), f = t - i;
  const a = STOPS[i], b = STOPS[Math.min(i + 1, STOPS.length - 1)];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

// Disegna un waterfall (lista di slice {t, bins:Uint8Array}) su un canvas 2D.
export function drawWaterfall(ctx, W, H, slices, opts = {}) {
  const { fMin = 20, fMax = 200, qMin = -110, qMax = -20, guides = [], startMs = null, endMs = null, light = false } = opts;
  ctx.fillStyle = light ? '#f4f4f8' : '#000';
  ctx.fillRect(0, 0, W, H);
  if (!slices.length) return;
  const nBins = slices[0].bins.length;

  // Range dinamico sui quantili per massimizzare il contrasto.
  let lo = 255, hi = 0;
  for (const s of slices) for (const v of s.bins) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 20) hi = lo + 20;

  const cols = Math.max(slices.length, 60);
  const colW = W / cols;
  slices.forEach((s, xi) => {
    const x = (xi / cols) * W;
    for (let b = 0; b < nBins; b++) {
      const y = H - (b + 1) / nBins * H;
      ctx.fillStyle = wfColor((s.bins[b] - lo) / (hi - lo));
      ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(colW) + 1, Math.ceil(H / nBins) + 1);
    }
  });

  // Linee guida orizzontali alle frequenze delle bande.
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  ctx.font = '9px monospace';
  for (const g of guides) {
    const y = H - (g.hz - fMin) / (fMax - fMin) * H;
    if (y < 0 || y > H) continue;
    ctx.strokeStyle = g.color;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = g.color;
    ctx.fillText(g.hz + 'Hz', 3, y - 2);
  }
  ctx.setLineDash([]);

  if (startMs && endMs) {
    ctx.fillStyle = light ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.4)';
    ctx.font = '9px monospace';
    ctx.fillText(fmtClock(startMs), 3, H - 3);
    const lbl = fmtClock(endMs);
    ctx.fillText(lbl, W - ctx.measureText(lbl).width - 3, H - 3);
  }
}

export function setupCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const H = cssH || canvas.clientHeight || 100;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}
