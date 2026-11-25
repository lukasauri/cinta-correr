'use strict';
/* Editor de entrenamientos personalizados */

function estStepSec(st) { return st.type === 'time' ? st.value : (st.speed > 0 ? st.value / (st.speed / 3.6) : 0); }
function estStepDist(st) { return st.type === 'dist' ? st.value : st.value * st.speed / 3.6; }
function workoutTotals(w) { return w.steps.reduce((a, s) => ({ sec: a.sec + estStepSec(s), dist: a.dist + estStepDist(s) }), { sec: 0, dist: 0 }); }
/** Paso: objetivo por ritmo/velocidad (target 'speed') o por zona de pulso (target 'hr': zone 1–5,
 *  speed = con lo que empieza, maxSpeed = lo más rápido que puede poner la app). */
function mkStep(name, type, value, speed, extra) { return { id: uid(), name, type, value, speed, ...(extra || {}) }; }

function sampleWorkouts() {
  const intervals = [mkStep('Calentamiento', 'time', 300, 6)];
  for (let i = 1; i <= 6; i++) {
    intervals.push(mkStep(`Serie ${i}/6`, 'time', 60, 11));
    if (i < 6) intervals.push(mkStep('Recuperación', 'time', 90, 6.5));
  }
  intervals.push(mkStep('Enfriamiento', 'time', 300, 5));
  return [
    { id: uid(), name: 'Intervalos 6 × 1 min', steps: intervals },
    {
      id: uid(), name: 'Progresivo 30 min', steps: [
        mkStep('Calentamiento', 'time', 300, 6.5), mkStep('Suave', 'time', 300, 8), mkStep('Medio', 'time', 300, 9),
        mkStep('Alegre', 'time', 300, 10), mkStep('Fuerte', 'time', 300, 11), mkStep('Enfriamiento', 'time', 300, 5.5)]
    },
    { id: uid(), name: '5 km constante', steps: [mkStep('Calentamiento', 'dist', 500, 7), mkStep('Ritmo', 'dist', 4000, 10), mkStep('Enfriamiento', 'dist', 500, 6)] },
    { id: uid(), name: 'Caminata 20 min', steps: [mkStep('Caminar', 'time', 1200, 5.5)] },
  ];
}

let editSel = null;

function saveWorkouts() { Store.set('workouts', App.workouts); refreshWorkoutSelect(); }

function renderWorkoutsView() {
  if (!editSel && App.workouts.length) editSel = App.workouts[0].id;
  renderWoList();
  renderEditor();
}

function renderWoList() {
  const list = $('#woList');
  list.innerHTML = '';
  list.append(h('div', { class: 'row gap' },
    h('button', { class: 'btn primary', onclick: newWorkout }, '+ Nuevo'),
    h('button', { class: 'btn', onclick: importWorkoutFile }, 'Importar…')));
  App.workouts.forEach(w => {
    const t = workoutTotals(w);
    list.append(h('div', {
      class: 'wo-item' + (w.id === editSel ? ' active' : ''),
      onclick: () => { editSel = w.id; renderWorkoutsView(); }
    },
      h('div', { class: 'wo-name' }, w.name || '(sin nombre)'),
      h('div', { class: 'wo-meta' }, `${w.steps.length} pasos · ${fmtTime(t.sec)} · ${(t.dist / 1000).toFixed(2)} km`)));
  });
}

function newWorkout() {
  const w = { id: uid(), name: 'Nuevo entrenamiento', steps: [mkStep('Calentamiento', 'time', 300, 6), mkStep('Principal', 'time', 1200, 9), mkStep('Enfriamiento', 'time', 300, 5)] };
  App.workouts.push(w);
  editSel = w.id;
  saveWorkouts(); renderWorkoutsView();
}

function workoutChanged(w, structural) {
  saveWorkouts();
  renderWoList();
  if (structural) renderEditor(); else updateEditorSummary(w);
}

function updateEditorSummary(w) {
  const t = workoutTotals(w);
  const sum = $('#woSummary');
  if (sum) sum.textContent = `${w.steps.length} pasos · duración ≈ ${fmtTime(t.sec)} · distancia ≈ ${(t.dist / 1000).toFixed(2)} km · ritmo medio ${t.dist ? fmtPace(t.dist / t.sec * 3.6) : '--:--'} /km`;
  const cv = $('#woPreview');
  if (cv) drawProfile(cv, w.steps);
}

function renderEditor() {
  const box = $('#woEditor');
  box.innerHTML = '';
  const w = App.workouts.find(x => x.id === editSel);
  if (!w) { box.append(h('div', { class: 'empty' }, 'Crea un entrenamiento nuevo para empezar.')); return; }

  box.append(h('div', { class: 'row gap wrap' },
    h('input', { class: 'wo-title', value: w.name, placeholder: 'Nombre del entrenamiento', oninput: e => { w.name = e.target.value; saveWorkouts(); renderWoList(); } }),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn primary', onclick: () => { $('#selWorkout').value = w.id; onWorkoutSelected(); switchView('train'); } }, '▶ Usar'),
    h('button', { class: 'btn', onclick: () => { const c = JSON.parse(JSON.stringify(w)); c.id = uid(); c.name += ' (copia)'; c.steps.forEach(s => s.id = uid()); App.workouts.push(c); editSel = c.id; saveWorkouts(); renderWorkoutsView(); } }, 'Duplicar'),
    h('button', { class: 'btn', onclick: () => download(`${(w.name || 'entrenamiento').replace(/[^\w\-áéíóúñ ]/gi, '_')}.json`, JSON.stringify({ cintapcWorkout: 1, ...w }, null, 2), 'application/json') }, 'Exportar'),
    h('button', {
      class: 'btn danger', onclick: () => {
        if (!confirm(`¿Eliminar "${w.name}"?`)) return;
        App.workouts = App.workouts.filter(x => x !== w); editSel = null; saveWorkouts(); renderWorkoutsView();
      }
    }, 'Eliminar')));

  const usePace = App.settings.workoutUnit === 'pace';
  const unitBtn = (unit, label) => h('button', {
    class: 'unit-btn' + (App.settings.workoutUnit === unit ? ' active' : ''),
    onclick: () => setUnits(unit)
  }, label);
  box.append(h('div', { class: 'row gap wrap' },
    h('span', { class: 'muted' }, 'Unidades (en toda la app):'),
    h('div', { class: 'unit-switch' }, unitBtn('speed', 'Velocidad (km/h)'), unitBtn('pace', 'Ritmo (min/km)'))));

  const tbody = h('tbody');
  w.steps.forEach((st, i) => tbody.append(stepRow(w, st, i)));
  box.append(h('div', { class: 'table-wrap' }, h('table', { class: 'steps' },
    h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Nombre'), h('th', {}, 'Tipo'), h('th', {}, 'Duración / distancia'),
      h('th', {}, 'Objetivo'), h('th', {}), h('th', {}), h('th', {}))),
    tbody)));

  box.append(h('div', { class: 'row gap' },
    h('button', { class: 'btn', onclick: () => { const last = w.steps[w.steps.length - 1]; w.steps.push(mkStep('', 'time', 60, last ? last.speed : 8)); workoutChanged(w, true); } }, '+ Paso'),
    h('button', { class: 'btn', onclick: () => openSeriesDialog(w) }, '+ Series (intervalos)')));

  box.append(h('div', { class: 'muted', id: 'woSummary' }));
  box.append(h('canvas', { id: 'woPreview', class: 'preview' }));
  box.append(zoneLegend());
  box.append(h('p', { class: 'muted small' }, usePace
    ? 'Duración: escribe mm:ss (p. ej. 1:30) o minutos (p. ej. 5). Distancia en metros. Ritmo en min/km (p. ej. 5:30). Deja el ritmo vacío o pon 0 para que la cinta se pause durante ese paso (solo en pasos por tiempo).'
    : 'Duración: escribe mm:ss (p. ej. 1:30) o minutos (p. ej. 5). Distancia en metros. Velocidad 0 = la cinta se pausa durante ese paso (solo en pasos por tiempo).'),
    h('p', { class: 'muted small' }, 'Paso por zona de pulso: la cinta empieza al ritmo indicado y la app lo ajusta poco a poco para mantener el pulso en la zona, sin pasar nunca del máximo. Necesita el pulsómetro conectado; si se pierde el pulso, mantiene la velocidad.'));
  requestAnimationFrame(() => updateEditorSummary(w));
}

/** Campo de ritmo o velocidad (según las unidades) para un valor en km/h. allowZero: vacío/0 = pausa. */
function speedInput(get, set, allowZero) {
  const usePace = isPace();
  const show = () => usePace ? (get() > 0 ? fmtPace(get()) : '') : get();
  const input = h('input', {
    class: 'in-speed', placeholder: usePace ? 'm:ss' : 'km/h', value: show(),
    ...(usePace ? {} : { type: 'number', step: '0.1', min: '0', max: '25' }),
    onchange: e => {
      let v = usePace ? paceToKmh(e.target.value) : parseFloat(e.target.value);
      if (usePace && v === null) { toast('Escribe el ritmo como minutos:segundos por km, p. ej. 5:30', 'warn'); e.target.value = show(); return; }
      if (isNaN(v) || v < 0) v = 0;
      if (!usePace) v = Math.round(v * 10) / 10;
      if (v <= 0 && !allowZero) { toast('Pon un ritmo o velocidad', 'warn'); e.target.value = show(); return; }
      if (set(Math.min(v, 25)) === false) { e.target.value = show(); return; }
      e.target.value = show();
    }
  });
  return h('span', { class: 'speed-in' }, input, h('span', { class: 'muted' }, usePace ? ' /km' : ' km/h'));
}

function stepRow(w, st, i) {
  const usePace = isPace();
  const isHr = st.target === 'hr';
  const chip = h('span', { class: 'zone-chip' });
  const paintChip = () => {
    const z = stepZone(st);
    chip.textContent = z ? `Z${z}` : 'pausa';
    chip.style.setProperty('--zc', stepColor(st));
    chip.title = isHr ? 'Zona de pulso' : 'Zona de ritmo';
  };
  paintChip();
  const changed = (structural) => { paintChip(); workoutChanged(w, structural); };

  // Objetivo: ritmo/velocidad o zona de pulso
  const targetSel = h('select', {
    value: isHr ? 'hr' : 'speed', onchange: e => {
      if (e.target.value === 'hr') {
        st.target = 'hr';
        st.zone = st.zone || 2;
        if (!(st.speed > 0)) st.speed = 3600 / (App.settings.freeStartPace || 360);
        st.maxSpeed = st.maxSpeed > st.speed ? st.maxSpeed : Math.round((st.speed + 2) * 10) / 10;
      } else { delete st.target; delete st.zone; delete st.maxSpeed; }
      changed(true);
    }
  }, h('option', { value: 'speed' }, usePace ? 'Ritmo' : 'Velocidad'), h('option', { value: 'hr' }, 'Zona de pulso'));

  let valueCell, detailCell;
  if (isHr) {
    const ranges = hrZoneRanges();
    valueCell = h('td', {}, h('select', { class: 'zone-sel', value: String(st.zone), onchange: e => { st.zone = parseInt(e.target.value, 10); changed(); } },
      ZONE_NAMES.map((n, z) => h('option', { value: String(z + 1) }, `Z${z + 1} · ${ranges[z]} ppm`))));
    detailCell = h('td', { class: 'hr-detail' },
      h('label', {}, h('small', { class: 'muted' }, 'empieza'), speedInput(() => st.speed, v => {
        if (st.maxSpeed && v > st.maxSpeed) { toast('El inicio no puede ser más rápido que el máximo', 'warn'); return false; }
        st.speed = v; changed();
      })),
      h('label', {}, h('small', { class: 'muted' }, 'máximo'), speedInput(() => st.maxSpeed, v => {
        if (v < st.speed) { toast('El máximo no puede ser más lento que el inicio', 'warn'); return false; }
        st.maxSpeed = v; changed();
      })));
  } else {
    const other = h('span', { class: 'muted' });
    const paintOther = () => { other.textContent = usePace ? (st.speed > 0 ? `${st.speed.toFixed(1)} km/h` : '') : (st.speed > 0 ? `${fmtPace(st.speed)} /km` : ''); };
    paintOther();
    valueCell = h('td', {}, speedInput(() => st.speed, v => {
      if (st.type === 'dist' && v <= 0) { toast('Un paso por distancia necesita un ritmo o velocidad', 'warn'); return false; }
      st.speed = v; paintOther(); changed();
    }, true));
    detailCell = h('td', {}, other);
  }

  const valInput = h('input', {
    class: 'in-val', value: st.type === 'time' ? fmtTime(st.value) : String(st.value),
    onchange: e => {
      if (st.type === 'time') { const v = parseTime(e.target.value); if (v > 0) st.value = v; e.target.value = fmtTime(st.value); }
      else { const v = parseFloat(e.target.value.replace(',', '.')); if (v > 0) st.value = Math.round(v); e.target.value = st.value; }
      workoutChanged(w);
    }
  });
  const move = d => { const j = i + d; if (j < 0 || j >= w.steps.length) return; [w.steps[i], w.steps[j]] = [w.steps[j], w.steps[i]]; workoutChanged(w, true); };
  return h('tr', {},
    h('td', { class: 'muted' }, i + 1),
    h('td', {}, h('input', { value: st.name || '', placeholder: 'Nombre', oninput: e => { st.name = e.target.value; workoutChanged(w); } })),
    h('td', {}, h('select', {
      value: st.type, onchange: e => {
        const nt = e.target.value;
        if (nt === 'dist' && st.speed <= 0) { toast('Un paso por distancia necesita velocidad mayor que 0', 'warn'); e.target.value = st.type; return; }
        st.value = Math.max(1, Math.round(nt === 'dist' ? estStepDist(st) : estStepSec(st)));
        st.type = nt; workoutChanged(w, true);
      }
    }, h('option', { value: 'time' }, 'Tiempo'), h('option', { value: 'dist' }, 'Distancia'))),
    h('td', {}, valInput, st.type === 'dist' ? h('span', { class: 'muted' }, ' m') : null),
    h('td', {}, targetSel),
    valueCell,
    detailCell,
    h('td', {}, chip),
    h('td', { class: 'row-actions' },
      h('button', { class: 'mini', title: 'Subir', onclick: () => move(-1) }, '↑'),
      h('button', { class: 'mini', title: 'Bajar', onclick: () => move(1) }, '↓'),
      h('button', { class: 'mini', title: 'Duplicar', onclick: () => { w.steps.splice(i + 1, 0, { ...st, id: uid() }); workoutChanged(w, true); } }, '⧉'),
      h('button', { class: 'mini danger', title: 'Borrar', onclick: () => { w.steps.splice(i, 1); workoutChanged(w, true); } }, '✕')));
}

/** Leyenda de colores del gráfico del entrenamiento. */
function zoneLegend() {
  return h('div', { class: 'zone-legend' },
    ZONE_COLORS.map((c, i) => h('span', { style: { '--zc': c } }, `Z${i + 1} ${ZONE_NAMES[i]}`)),
    h('span', { style: { '--zc': PAUSE_COLOR } }, 'Pausa'),
    h('small', { class: 'muted' }, 'Pasos por ritmo: zonas de ritmo · pasos por pulso: zonas de pulso (Ajustes > Perfil)'));
}

function openSeriesDialog(w) {
  const dlg = $('#dlgSeries');
  const f = dlg.querySelector('form');
  const usePace = App.settings.workoutUnit === 'pace';
  // Etiquetas y valores según la unidad elegida (el valor que hubiera se convierte).
  $('#lblWorkSpeed').textContent = usePace ? 'Ritmo serie (min/km)' : 'Velocidad serie (km/h)';
  $('#lblRestSpeed').textContent = usePace ? 'Ritmo recuperación (min/km)' : 'Velocidad recuperación (km/h)';
  if (f.dataset.unit !== (usePace ? 'pace' : 'speed')) {
    const conv = (val) => {
      if (usePace) { const k = parseFloat(String(val).replace(',', '.')); return k > 0 ? fmtPace(k) : ''; }
      const k = paceToKmh(val); return k ? k.toFixed(1) : '0';
    };
    // Se leen antes de cambiar el tipo del campo (un campo numérico no admite "5:30").
    const work = conv(f.workSpeed.value), rest = conv(f.restSpeed.value);
    f.workSpeed.type = f.restSpeed.type = usePace ? 'text' : 'number';
    f.workSpeed.value = work;
    f.restSpeed.value = rest;
    f.dataset.unit = usePace ? 'pace' : 'speed';
  }
  const readSpeed = (val) => usePace ? paceToKmh(val) : parseFloat(String(val).replace(',', '.'));
  f.onsubmit = e => {
    e.preventDefault();
    const reps = clamp(parseInt(f.reps.value, 10) || 1, 1, 50);
    const wt = parseTime(f.workTime.value), ws = readSpeed(f.workSpeed.value);
    const rt = parseTime(f.restTime.value), rs = readSpeed(f.restSpeed.value);
    if (!(wt > 0) || !(ws > 0)) { toast(`Revisa la duración y ${usePace ? 'el ritmo' : 'la velocidad'} de la serie`, 'warn'); return; }
    for (let i = 1; i <= reps; i++) {
      w.steps.push(mkStep(`Serie ${i}/${reps}`, 'time', wt, Math.min(ws, 25)));
      if (rt > 0 && (i < reps || f.lastRest.checked)) w.steps.push(mkStep('Recuperación', 'time', rt, rs > 0 ? Math.min(rs, 25) : 0));
    }
    dlg.close();
    workoutChanged(w, true);
  };
  dlg.showModal();
}

function importWorkoutFile() {
  const inp = h('input', { type: 'file', accept: '.json,application/json' });
  inp.onchange = async () => {
    try {
      const data = JSON.parse(await inp.files[0].text());
      const list = Array.isArray(data) ? data : [data];
      let n = 0;
      list.forEach(w => {
        if (!w || !Array.isArray(w.steps)) return;
        const steps = w.steps.filter(s => s && (s.type === 'time' || s.type === 'dist') && s.value > 0)
          .map(s => mkStep(String(s.name || ''), s.type, Number(s.value), Number(s.speed) || 0,
            s.target === 'hr' && s.zone >= 1 && s.zone <= 5 ? { target: 'hr', zone: Number(s.zone), maxSpeed: Number(s.maxSpeed) || (Number(s.speed) || 8) + 2 } : null));
        App.workouts.push({ id: uid(), name: String(w.name || 'Importado'), steps });
        n++;
      });
      saveWorkouts(); renderWorkoutsView();
      toast(n ? `Importados ${n} entrenamiento(s)` : 'El archivo no contiene entrenamientos válidos', n ? 'info' : 'warn');
    } catch (e) { toast('No se pudo leer el archivo', 'error'); }
  };
  inp.click();
}

function refreshWorkoutSelect() {
  const sel = $('#selWorkout');
  if (!sel) return;
  const cur = sel.value || Store.get('lastWorkout', '');
  sel.innerHTML = '';
  sel.append(h('option', { value: '' }, 'Carrera libre'));
  App.workouts.forEach(w => sel.append(h('option', { value: w.id }, w.name || '(sin nombre)')));
  sel.value = App.workouts.some(w => w.id === cur) ? cur : '';
}

function selectedWorkout() {
  const sel = $('#selWorkout');
  return sel && sel.value ? App.workouts.find(w => w.id === sel.value) || null : null;
}
