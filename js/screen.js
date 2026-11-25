'use strict';
/* Pantalla de entrenamiento: widgets personalizables */

const ZONE_COLORS = ['#94a3b8', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444'];
const ZONE_NAMES = ['Recuperación', 'Base aeróbica', 'Aeróbico', 'Umbral', 'Máximo'];

const WIDGETS = {
  // Los widgets de velocidad siguen la unidad elegida en Ajustes: el "principal" la usa y el
  // "secundario" muestra la otra (en km/h: velocidad y ritmo; en min/km: ritmo y velocidad).
  speed: {
    name: 'Velocidad / ritmo (principal)', label: () => isPace() ? 'Ritmo' : 'Velocidad', unit: () => mainUnit(), val: c => fmtMain(c.speed),
    sub: c => c.session ? `objetivo ${fmtMain(c.target)}${isPace() ? ' /km' : ''}` : ''
  },
  pace: { name: 'Velocidad / ritmo (secundario)', label: () => isPace() ? 'Velocidad' : 'Ritmo', unit: () => altUnit(), val: c => fmtAlt(c.speed) },
  target: { name: 'Objetivo (principal)', label: () => isPace() ? 'Ritmo objetivo' : 'Velocidad objetivo', unit: () => mainUnit(), val: c => fmtMain(c.target) },
  targetPace: { name: 'Objetivo (secundario)', label: () => isPace() ? 'Velocidad objetivo' : 'Ritmo objetivo', unit: () => altUnit(), val: c => fmtAlt(c.target) },
  time: { name: 'Tiempo', val: c => fmtTime(c.elapsed) },
  distance: { name: 'Distancia', unit: 'km', val: c => (c.dist / 1000).toFixed(2) },
  kcal: { name: 'Calorías', unit: 'kcal', val: c => Math.round(c.kcal) },
  hr: {
    name: 'Pulso', unit: 'ppm', val: c => c.hr || '--',
    sub: c => c.hr ? `Zona ${c.zone} · ${c.hrPct}%` : 'sin datos',
    color: c => c.hr ? ZONE_COLORS[c.zone - 1] : null
  },
  hrZone: { name: 'Zona de pulso', custom: 'zone' },
  avgSpeed: { name: 'Media (principal)', label: () => isPace() ? 'Ritmo medio' : 'Velocidad media', unit: () => mainUnit(), val: c => fmtMain(c.avgSpeed) },
  avgPace: { name: 'Media (secundaria)', label: () => isPace() ? 'Velocidad media' : 'Ritmo medio', unit: () => altUnit(), val: c => fmtAlt(c.avgSpeed) },
  avgHr: { name: 'Pulso medio', unit: 'ppm', val: c => c.avgHr || '--' },
  maxHr: { name: 'Pulso máximo', unit: 'ppm', val: c => c.maxHrSess || '--' },
  stepRemaining: {
    name: 'Resta del paso',
    val: c => !c.step ? '--' : c.step.type === 'time' ? fmtTime(c.stepRemaining) : Math.max(0, Math.round(c.stepRemainingDist)),
    unit: c => c.step && c.step.type === 'dist' ? 'm' : ''
  },
  totalRemaining: { name: 'Resta total', val: c => c.steps ? fmtTime(c.totalRemaining) : '--' },
  step: { name: 'Paso actual', custom: 'step' },
  next: { name: 'Siguiente paso', custom: 'next' },
  progress: { name: 'Progreso del entrenamiento', custom: 'progress' },
  chart: { name: 'Gráfica velocidad / pulso', custom: 'chart' },
  clock: { name: 'Reloj', val: () => new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) },
};

const SIZES = [['s', 'Pequeño'], ['m', 'Ancho'], ['t', 'Alto'], ['l', 'Grande'], ['w', 'Fila completa'], ['w2', 'Fila completa doble']];

/** Contexto con todos los valores calculados para pintar */
function buildCtx() {
  const s = App.session, L = App.live, hr = currentHr();
  const c = {
    session: s, speed: L.speed || 0, target: App.targetSpeed || 0,
    elapsed: s ? s.elapsed : 0, dist: s ? s.dist : 0, kcal: s ? s.kcal : 0, hr,
  };
  c.avgSpeed = s && s.elapsed > 5 ? s.dist / s.elapsed * 3.6 : 0;
  c.avgHr = s && s.hrTime > 0 ? Math.round(s.hrSum / s.hrTime) : null;
  c.maxHrSess = s && s.hrMax ? s.hrMax : null;
  if (hr) {
    const pct = hr / App.settings.maxHr;
    c.hrPct = Math.round(pct * 100);
    c.zone = pct < 0.6 ? 1 : pct < 0.7 ? 2 : pct < 0.8 ? 3 : pct < 0.9 ? 4 : 5;
  }
  if (s && s.steps) {
    const st = s.steps[s.stepIdx];
    c.steps = s.steps; c.step = st; c.stepIdx = s.stepIdx; c.nSteps = s.steps.length;
    c.nextStep = s.steps[s.stepIdx + 1] || null;
    if (st) {
      const v = Math.max(c.speed > 0.5 ? c.speed : st.speed, 0.5) / 3.6;
      if (st.type === 'time') {
        c.stepRemaining = st.value - s.stepElapsed;
        c.stepFrac = s.stepElapsed / st.value;
      } else {
        c.stepRemainingDist = st.value - s.stepDist;
        c.stepRemaining = c.stepRemainingDist / v;
        c.stepFrac = s.stepDist / st.value;
      }
      c.stepFrac = clamp(c.stepFrac, 0, 1);
      let rest = 0;
      for (let i = s.stepIdx + 1; i < s.steps.length; i++) rest += estStepSec(s.steps[i]);
      c.totalRemaining = Math.max(0, c.stepRemaining) + rest;
    }
  } else if (!s) {
    const w = selectedWorkout();
    if (w) c.previewSteps = w.steps;
  }
  return c;
}

function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  grid.classList.toggle('editing', App.editing);
  App.widgetEls = [];
  App.layout.widgets.forEach((w, i) => {
    const def = WIDGETS[w.id];
    if (!def) return;
    const el = h('div', { class: `widget size-${w.size} w-${w.id}`, 'data-i': i });
    el.append(h('div', { class: 'w-label' }, def.label ? def.label() : def.name));
    if (def.custom) buildCustom(def.custom, el);
    else {
      el.append(h('div', { class: 'w-main' }, h('span', { class: 'w-num' }, '--'), h('span', { class: 'w-unit' })));
      el.append(h('div', { class: 'w-sub' }));
    }
    if (App.editing) addEditTools(el, i);
    grid.append(el);
    App.widgetEls.push({ el, def, w, cache: {} });
  });
  if (App.editing) grid.append(h('div', { class: 'widget size-s add-tile', onclick: () => $('#selAddWidget').focus() }, '+ Añadir widget'));
  updateGrid(true);
}

function addEditTools(el, i) {
  el.draggable = true;
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop-target'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (isNaN(from) || from === i) return;
    const arr = App.layout.widgets;
    const [moved] = arr.splice(from, 1);
    arr.splice(i, 0, moved);
    saveLayout(); renderGrid();
  });
  const sizeSel = h('select', {
    value: App.layout.widgets[i].size, title: 'Tamaño',
    onchange: e => { App.layout.widgets[i].size = e.target.value; saveLayout(); renderGrid(); }
  }, SIZES.map(([v, t]) => h('option', { value: v }, t)));
  el.append(h('div', { class: 'w-edit' },
    h('span', { class: 'handle', title: 'Arrastra para mover' }, '⠿'),
    h('button', { class: 'mini', title: 'Mover antes', onclick: () => moveWidget(i, -1) }, '◀'),
    h('button', { class: 'mini', title: 'Mover después', onclick: () => moveWidget(i, 1) }, '▶'),
    sizeSel,
    h('button', { class: 'mini danger', title: 'Quitar', onclick: () => { App.layout.widgets.splice(i, 1); saveLayout(); renderGrid(); } }, '✕')
  ));
}

function moveWidget(i, d) {
  const arr = App.layout.widgets, j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  saveLayout(); renderGrid();
}

function buildCustom(type, el) {
  if (type === 'step' || type === 'next') {
    el.append(h('div', { class: 'st-title' }), h('div', { class: 'st-target' }));
    if (type === 'step') el.append(h('div', { class: 'bar' }, h('div', { class: 'bar-fill' })));
  } else if (type === 'progress') {
    el.append(h('div', { class: 'prog' }, h('div', { class: 'prog-segs' }), h('div', { class: 'prog-marker' })), h('div', { class: 'w-sub prog-info' }));
  } else if (type === 'chart') {
    el.append(h('canvas', { class: 'chart' }));
  } else if (type === 'zone') {
    el.append(h('div', { class: 'zones' }, ZONE_COLORS.map((col, i) => h('div', { class: 'zone', style: { '--zc': col } }, h('b', {}, `Z${i + 1}`), h('span', {}, ZONE_NAMES[i])))));
  }
}

function setText(el, txt) { txt = String(txt); if (el.textContent !== txt) el.textContent = txt; }

function updateGrid(force) {
  if (!App.widgetEls) return;
  const c = buildCtx();
  const now = Date.now();
  App.widgetEls.forEach(item => {
    const { el, def } = item;
    if (def.custom) return updateCustom(def.custom, item, c, force, now);
    setText(el.querySelector('.w-num'), def.val(c));
    setText(el.querySelector('.w-unit'), typeof def.unit === 'function' ? def.unit(c) : (def.unit || ''));
    setText(el.querySelector('.w-sub'), def.sub ? def.sub(c) : '');
    const col = def.color ? def.color(c) : null;
    el.style.setProperty('--wcolor', col || 'var(--text)');
  });
  updateTargetBox();
}

/** Recuadro de velocidad / ritmo objetivo: título, valor con su unidad, la otra unidad y atajos. */
function updateTargetBox() {
  const box = $('#speedCtl');
  if (!box) return;
  const pace = isPace(), s = App.session;
  // Con un entrenamiento elegido y sin empezar, se muestra cómo empieza (lo marca el entrenamiento).
  const w = !s ? selectedWorkout() : null;
  const first = w && w.steps[0];
  const kmh = first ? first.speed : App.targetSpeed;
  const what = pace ? 'Ritmo' : 'Velocidad';
  setText($('#targetLabel'), s ? `${what} objetivo` : first ? 'El entrenamiento empieza a' : `${what} inicial`);
  setText($('#targetSpeed'), kmh > 0 ? fmtMain(kmh) : (pace ? '--:--' : '0.0'));
  setText($('#targetUnit'), pace ? '/km' : 'km/h');
  setText($('#targetAlt'), kmh > 0 ? (pace ? `${fmtAlt(kmh)} km/h` : `${fmtAlt(kmh)} /km`) : (first ? 'pausa' : ''));
  setText($('#slowerTxt'), pace ? 'más lento' : 'más despacio');
  setText($('#presetsLabel'), pace ? 'Elegir ritmo (min/km):' : 'Elegir velocidad (km/h):');
  box.classList.toggle('locked', !!first);
  box.title = first ? 'El entrenamiento marca la velocidad. Se puede ajustar cuando esté en marcha.' : '';
}

function updateCustom(type, item, c, force, now) {
  const el = item.el;
  if (type === 'step') {
    if (c.step) {
      setText(el.querySelector('.st-title'), `${c.step.name || 'Paso'}  ·  ${c.stepIdx + 1}/${c.nSteps}`);
      setText(el.querySelector('.st-target'), fmtTarget(c.step.speed));
      el.querySelector('.bar-fill').style.width = (c.stepFrac * 100).toFixed(1) + '%';
    } else {
      setText(el.querySelector('.st-title'), c.session ? 'Carrera libre' : (c.previewSteps ? selectedWorkout().name : 'Carrera libre'));
      setText(el.querySelector('.st-target'), c.session ? fmtTarget(c.target) : 'Pulsa Iniciar');
      el.querySelector('.bar-fill').style.width = '0%';
    }
  } else if (type === 'next') {
    const n = c.nextStep;
    if (n) {
      setText(el.querySelector('.st-title'), n.name || 'Siguiente');
      setText(el.querySelector('.st-target'), `${fmtTarget(n.speed)} · ${n.type === 'time' ? fmtTime(n.value) : fmtDist(n.value)}`);
    } else {
      setText(el.querySelector('.st-title'), c.step ? 'Último paso' : '—');
      setText(el.querySelector('.st-target'), c.step ? 'Al terminar se detiene la cinta' : '');
    }
  } else if (type === 'progress') {
    const steps = c.steps || c.previewSteps;
    const segs = el.querySelector('.prog-segs');
    const key = steps ? JSON.stringify(steps.map(s => [s.type, s.value, s.speed])) : '';
    if (item.cache.key !== key) {
      item.cache.key = key;
      segs.innerHTML = '';
      if (steps) {
        const maxV = Math.max(...steps.map(s => s.speed), 1);
        steps.forEach(s => segs.append(h('div', { class: 'seg', style: { flexGrow: Math.max(1, estStepSec(s)), height: (20 + 80 * s.speed / maxV) + '%' }, title: `${s.name || ''} ${s.speed} km/h` })));
      }
    }
    const marker = el.querySelector('.prog-marker');
    if (steps && c.steps) {
      const total = steps.reduce((a, s) => a + estStepSec(s), 0);
      let done = 0;
      for (let i = 0; i < c.stepIdx; i++) done += estStepSec(steps[i]);
      done += (c.stepFrac || 0) * estStepSec(steps[c.stepIdx] || { type: 'time', value: 0 });
      marker.style.display = 'block';
      marker.style.left = (done / total * 100).toFixed(2) + '%';
      Array.from(segs.children).forEach((sg, i) => { sg.classList.toggle('done', i < c.stepIdx); sg.classList.toggle('cur', i === c.stepIdx); });
      setText(el.querySelector('.prog-info'), `${Math.round(done / total * 100)}% · quedan ${fmtTime(c.totalRemaining)}`);
    } else {
      marker.style.display = 'none';
      Array.from(segs.children).forEach(sg => sg.classList.remove('done', 'cur'));
      setText(el.querySelector('.prog-info'), steps ? `Duración estimada ${fmtTime(steps.reduce((a, s) => a + estStepSec(s), 0))}` : 'Carrera libre: sin plan');
    }
  } else if (type === 'chart') {
    if (!force && item.cache.last && now - item.cache.last < 2000) return;
    item.cache.last = now;
    const s = App.session;
    const smp = s ? s.samples : [];
    let xMax = s ? s.elapsed : 60, profile = null;
    const steps = c.steps || c.previewSteps;
    if (steps) {
      let x = 0;
      profile = steps.map(st => { const d = estStepSec(st); const p = { x0: x, x1: x + d, y: st.speed }; x += d; return p; });
      xMax = Math.max(xMax, x);
    }
    drawLineChart(el.querySelector('canvas'), {
      xMax: xMax * 1.02,
      profile,
      series: [
        { pts: smp.map(p => [p[1], p[3]]), color: cssVar('--accent'), axis: 0, min: 0 },
        { pts: smp.filter(p => p[4]).map(p => [p[1], p[4]]), color: cssVar('--hr'), axis: 1 },
      ]
    });
  } else if (type === 'zone') {
    Array.from(el.querySelectorAll('.zone')).forEach((z, i) => z.classList.toggle('on', c.zone === i + 1));
  }
}

function saveLayout() { Store.set('layout', App.layout); }

function applyLayoutStyles() {
  const L = App.layout, root = document.documentElement;
  root.dataset.theme = L.theme;
  root.style.setProperty('--accent', L.accent);
  root.style.setProperty('--cols', L.columns);
  root.style.setProperty('--row-h', L.rowHeight + 'px');
  root.style.setProperty('--font-scale', L.fontScale);
}

/* Barra de edición del diseño */
function setupLayoutEditor() {
  const sel = $('#selAddWidget');
  sel.innerHTML = '';
  Object.entries(WIDGETS).forEach(([id, d]) => sel.append(h('option', { value: id }, d.name)));
  $('#btnAddWidget').onclick = () => {
    const id = sel.value;
    const big = ['chart', 'progress'].includes(id);
    App.layout.widgets.push({ id, size: big ? 'w' : 's' });
    saveLayout(); renderGrid();
  };
  const bind = (id, key, parse) => {
    const el = $(id);
    el.value = App.layout[key];
    el.oninput = () => { App.layout[key] = parse(el.value); applyLayoutStyles(); saveLayout(); updateGrid(true); };
  };
  bind('#lyCols', 'columns', v => clamp(parseInt(v, 10) || 4, 2, 8));
  bind('#lyRow', 'rowHeight', v => clamp(parseInt(v, 10) || 130, 60, 400));
  bind('#lyFont', 'fontScale', v => clamp(parseFloat(v) || 1, 0.5, 2));
  bind('#lyAccent', 'accent', v => v);
  bind('#lyTheme', 'theme', v => v);
  $('#btnResetLayout').onclick = () => {
    if (!confirm('¿Restaurar el diseño de pantalla por defecto?')) return;
    App.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
    saveLayout(); applyLayoutStyles(); setupLayoutEditor(); renderGrid();
  };
}

function toggleEditing(on) {
  App.editing = on;
  $('#editBar').hidden = !on;
  $('#btnEditLayout').classList.toggle('active', on);
  renderGrid();
}
