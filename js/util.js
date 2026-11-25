'use strict';
/* Utilidades generales */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** Crea elementos DOM: h('div', {class:'x', onclick:fn}, hijo1, hijo2...) */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        // Las variables CSS (--algo) solo se pueden poner con setProperty.
        for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const hh = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return hh ? `${hh}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Ritmo en min/km a partir de km/h */
function fmtPace(kmh) {
  if (!kmh || kmh < 0.5) return '--:--';
  const t = Math.round(3600 / kmh);
  return `${Math.floor(t / 60)}:${pad(t % 60)}`;
}

/** Ritmo ("5:30" o "5.5" minutos por km) -> km/h con 3 decimales; null si no es válido. 0 o vacío = pausa. */
function paceToKmh(str) {
  const s = String(str).trim();
  if (s === '' || s === '0' || s === '-' || s === '--:--') return 0;
  const sec = parseTime(s);
  if (!(sec >= 120 && sec <= 3600)) return null; // entre 2:00 y 60:00 min/km (30 y 1 km/h)
  return Math.round(3600000 / sec) / 1000;
}

/** "mm:ss", "h:mm:ss" o un número (minutos) -> segundos */
function parseTime(str) {
  str = String(str).trim().replace(',', '.');
  if (!str) return 0;
  if (str.includes(':')) return str.split(':').map(Number).reduce((a, p) => a * 60 + (isNaN(p) ? 0 : p), 0);
  const n = parseFloat(str);
  return isNaN(n) ? 0 : Math.round(n * 60);
}

function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString('es-ES', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/* Almacenamiento local (localStorage con prefijo) */
const Store = {
  prefix: 'cintapc.',
  get(key, def) {
    try { const v = localStorage.getItem(this.prefix + key); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(this.prefix + key, JSON.stringify(val)); return true; }
    catch (e) { console.error(e); toast('No se pudo guardar (almacenamiento lleno). Exporta una copia y borra sesiones antiguas.', 'error'); return false; }
  },
  remove(key) { try { localStorage.removeItem(this.prefix + key); } catch (e) { } },
  keys() {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length)); } } catch (e) { }
    return out;
  }
};

/* Sonido y voz */
const Sound = {
  ctx: null,
  beep(freq = 880, dur = 0.15, vol = 0.35) {
    if (!App.settings.beeps) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      o.connect(g).connect(c.destination);
      o.start(); o.stop(c.currentTime + dur);
    } catch (e) { }
  },
  say(text) {
    if (!App.settings.voice || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-ES';
      const v = speechSynthesis.getVoices().find(v => v.lang && v.lang.toLowerCase().startsWith('es'));
      if (v) u.voice = v;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { }
  }
};

function speakSpeed(k) { return `${String(Math.round(k * 10) / 10).replace('.', ',')} kilómetros por hora`; }
/* Unidades: App.settings.workoutUnit = 'speed' (km/h) o 'pace' (min/km) */
const isPace = () => App.settings.workoutUnit === 'pace';
const mainUnit = () => isPace() ? 'min/km' : 'km/h';
const altUnit = () => isPace() ? 'km/h' : 'min/km';
const fmtMain = kmh => isPace() ? fmtPace(kmh) : (kmh || 0).toFixed(1);
const fmtAlt = kmh => isPace() ? (kmh || 0).toFixed(1) : fmtPace(kmh);

function speakPace(kmh) {
  const t = Math.round(3600 / kmh), m = Math.floor(t / 60), s = t % 60;
  return `ritmo de ${m} ${m === 1 ? 'minuto' : 'minutos'}${s ? ` ${s}` : ''} por kilómetro`;
}
/** Velocidad de un paso dicha como el usuario la escribe (km/h o ritmo). */
function speakTarget(kmh) { return App.settings.workoutUnit === 'pace' ? speakPace(kmh) : speakSpeed(kmh); }
/** Objetivo de un paso escrito en la unidad elegida, con la otra entre paréntesis. */
function fmtTarget(kmh) {
  if (!(kmh > 0)) return 'Pausa';
  return App.settings.workoutUnit === 'pace' ? `${fmtPace(kmh)} /km (${kmh.toFixed(1)} km/h)` : `${kmh.toFixed(1)} km/h (${fmtPace(kmh)} /km)`;
}
function speakDuration(sec) {
  sec = Math.round(sec);
  const m = Math.floor(sec / 60), s = sec % 60, parts = [];
  if (m) parts.push(`${m} ${m === 1 ? 'minuto' : 'minutos'}`);
  if (s) parts.push(`${s} segundos`);
  return parts.join(' y ') || '0 segundos';
}

/* Notificaciones */
function toast(msg, type = 'info') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast ${type}` }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

function download(name, content, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
