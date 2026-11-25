'use strict';
/* Gráficas en canvas (sin librerías externas) */

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const r = cv.getBoundingClientRect();
  const w = Math.max(10, r.width), hh = Math.max(10, r.height);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  return { ctx, w, h: hh };
}

function niceStep(range, target) {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

/**
 * opts: {
 *   xMax: segundos,
 *   series: [{ pts: [[x, y]], color, axis: 0|1, min?, max?, label }],
 *   profile?: [{ x0, x1, y }]  // velocidad objetivo (eje 0)
 * }
 */
function drawLineChart(cv, opts) {
  const { ctx, w, h } = setupCanvas(cv);
  const hasRight = opts.series.some(s => s.axis === 1 && s.pts.length);
  const pad = { l: 34, r: hasRight ? 34 : 10, t: 10, b: 20 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  if (pw < 20 || ph < 20) return;
  const muted = cssVar('--muted'), border = cssVar('--border');
  const xMax = Math.max(opts.xMax || 60, 60);
  const X = x => pad.l + x / xMax * pw;

  const ranges = [0, 1].map(a => {
    let mn = Infinity, mx = -Infinity;
    opts.series.filter(s => s.axis === a).forEach(s => {
      if (s.min != null) mn = Math.min(mn, s.min);
      if (s.max != null) mx = Math.max(mx, s.max);
      s.pts.forEach(p => { if (p[1] == null) return; mn = Math.min(mn, p[1]); mx = Math.max(mx, p[1]); });
    });
    if (a === 0 && opts.profile) opts.profile.forEach(p => { mn = Math.min(mn, p.y); mx = Math.max(mx, p.y); });
    if (!isFinite(mn)) return null;
    if (mx - mn < 2) { mx += 1; mn -= 1; }
    const pv = (mx - mn) * 0.08;
    return { mn: a === 0 ? Math.max(0, mn - pv) : mn - pv, mx: mx + pv };
  });
  const Y = (y, a) => { const r = ranges[a]; return pad.t + ph - (y - r.mn) / (r.mx - r.mn) * ph; };

  ctx.font = '11px system-ui, Segoe UI, sans-serif';
  ctx.lineWidth = 1;

  // rejilla y eje izquierdo
  if (ranges[0]) {
    const r = ranges[0], st = niceStep(r.mx - r.mn, 4);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(r.mn / st) * st; v <= r.mx; v += st) {
      const y = Y(v, 0);
      ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = muted; ctx.fillText(+v.toFixed(1), pad.l - 5, y);
    }
  }
  if (ranges[1] && hasRight) {
    const r = ranges[1], st = niceStep(r.mx - r.mn, 4);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const col = opts.series.find(s => s.axis === 1).color;
    for (let v = Math.ceil(r.mn / st) * st; v <= r.mx; v += st) { ctx.fillStyle = col; ctx.fillText(Math.round(v), w - pad.r + 5, Y(v, 1)); }
  }
  // eje X (tiempo)
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = muted;
  const xs = niceStep(xMax / 60, 6) * 60;
  for (let x = 0; x <= xMax; x += xs) ctx.fillText(fmtTime(x).replace(/^00:/, '0:'), X(x), h - pad.b + 4);

  // perfil objetivo
  if (opts.profile && ranges[0]) {
    opts.profile.forEach(p => {
      ctx.fillStyle = (p.color || cssVar('--accent')) + '40';
      const y = Y(p.y, 0);
      ctx.fillRect(X(p.x0), y, Math.max(1, X(Math.min(p.x1, xMax)) - X(p.x0)), pad.t + ph - y);
    });
  }

  // series
  opts.series.forEach(s => {
    if (!s.pts.length || !ranges[s.axis]) return;
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    s.pts.forEach(p => {
      if (p[1] == null) { started = false; return; }
      const x = X(p[0]), y = Y(p[1], s.axis);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

/** Perfil de un entrenamiento (barras velocidad × duración) */
function drawProfile(cv, steps) {
  const { ctx, w, h } = setupCanvas(cv);
  const total = steps.reduce((a, s) => a + estStepSec(s), 0);
  if (!total) return;
  const maxV = Math.max(...steps.map(s => s.speed), 1);
  const pad = { l: 30, r: 6, t: 8, b: 18 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const accent = cssVar('--accent'), muted = cssVar('--muted'), border = cssVar('--border');
  ctx.font = '11px system-ui, Segoe UI, sans-serif';
  const st = niceStep(maxV, 4);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= maxV * 1.1; v += st) {
    const y = pad.t + ph - v / (maxV * 1.1) * ph;
    ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(+v.toFixed(1), pad.l - 4, y);
  }
  let x = 0;
  steps.forEach(s => {
    const d = estStepSec(s), bw = d / total * pw, bh = Math.max(s.speed > 0 ? 0 : 3, s.speed / (maxV * 1.1) * ph);
    const x0 = pad.l + x / total * pw + 0.5;
    ctx.fillStyle = stepColor(s);
    ctx.fillRect(x0, pad.t + ph - bh, Math.max(1, bw - 1), bh);
    // Etiqueta de la zona dentro de la barra si cabe (con "♥" si es por pulso)
    const z = stepZone(s);
    if (z && bw >= 26 && bh >= 16) {
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui, Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`${s.target === 'hr' ? '♥' : ''}Z${z}`, x0 + bw / 2, pad.t + ph - bh + 3);
    }
    x += d;
  });
  ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const xs = niceStep(total / 60, 6) * 60;
  for (let t = 0; t <= total; t += xs) ctx.fillText(fmtTime(t), pad.l + t / total * pw, h - pad.b + 4);
}
