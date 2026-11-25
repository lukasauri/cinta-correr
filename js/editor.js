'use strict';
/* Editor de entrenamientos personalizados */

function estStepSec(st) { return st.type === 'time' ? st.value : (st.speed > 0 ? st.value / (st.speed / 3.6) : 0); }
function estStepDist(st) { return st.type === 'dist' ? st.value : st.value * st.speed / 3.6; }
function workoutTotals(w) { return w.steps.reduce((a, s) => ({ sec: a.sec + estStepSec(s), dist: a.dist + estStepDist(s) }), { sec: 0, dist: 0 }); }
function mkStep(name, type, value, speed) { return { id: uid(), name, type, value, speed }; }

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

  const tbody = h('tbody');
  w.steps.forEach((st, i) => tbody.append(stepRow(w, st, i)));
  box.append(h('div', { class: 'table-wrap' }, h('table', { class: 'steps' },
    h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Nombre'), h('th', {}, 'Tipo'), h('th', {}, 'Duración / distancia'), h('th', {}, 'Velocidad'), h('th', {}, 'Ritmo'), h('th', {}))),
    tbody)));

  box.append(h('div', { class: 'row gap' },
    h('button', { class: 'btn', onclick: () => { const last = w.steps[w.steps.length - 1]; w.steps.push(mkStep('', 'time', 60, last ? last.speed : 8)); workoutChanged(w, true); } }, '+ Paso'),
    h('button', { class: 'btn', onclick: () => openSeriesDialog(w) }, '+ Series (intervalos)')));

  box.append(h('div', { class: 'muted', id: 'woSummary' }));
  box.append(h('canvas', { id: 'woPreview', class: 'preview' }));
  box.append(h('p', { class: 'muted small' }, 'Duración: escribe mm:ss (p. ej. 1:30) o minutos (p. ej. 5). Distancia en metros. Velocidad 0 = la cinta se pausa durante ese paso (solo en pasos por tiempo).'));
  requestAnimationFrame(() => updateEditorSummary(w));
}

function stepRow(w, st, i) {
  const paceCell = h('td', { class: 'muted' }, fmtPace(st.speed));
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
    h('td', {}, h('input', {
      type: 'number', step: '0.1', min: '0', max: '25', class: 'in-speed', value: st.speed,
      onchange: e => {
        let v = parseFloat(e.target.value);
        if (isNaN(v) || v < 0) v = 0;
        if (st.type === 'dist' && v <= 0) { toast('Un paso por distancia necesita velocidad mayor que 0', 'warn'); e.target.value = st.speed; return; }
        st.speed = Math.round(v * 10) / 10; paceCell.textContent = fmtPace(st.speed); workoutChanged(w);
      }
    }), h('span', { class: 'muted' }, ' km/h')),
    paceCell,
    h('td', { class: 'row-actions' },
      h('button', { class: 'mini', title: 'Subir', onclick: () => move(-1) }, '↑'),
      h('button', { class: 'mini', title: 'Bajar', onclick: () => move(1) }, '↓'),
      h('button', { class: 'mini', title: 'Duplicar', onclick: () => { w.steps.splice(i + 1, 0, { ...st, id: uid() }); workoutChanged(w, true); } }, '⧉'),
      h('button', { class: 'mini danger', title: 'Borrar', onclick: () => { w.steps.splice(i, 1); workoutChanged(w, true); } }, '✕')));
}

function openSeriesDialog(w) {
  const dlg = $('#dlgSeries');
  const f = dlg.querySelector('form');
  f.onsubmit = e => {
    e.preventDefault();
    const reps = clamp(parseInt(f.reps.value, 10) || 1, 1, 50);
    const wt = parseTime(f.workTime.value), ws = parseFloat(String(f.workSpeed.value).replace(',', '.'));
    const rt = parseTime(f.restTime.value), rs = parseFloat(String(f.restSpeed.value).replace(',', '.'));
    if (!(wt > 0) || !(ws > 0)) { toast('Revisa la duración y velocidad de la serie', 'warn'); return; }
    for (let i = 1; i <= reps; i++) {
      w.steps.push(mkStep(`Serie ${i}/${reps}`, 'time', wt, ws));
      if (rt > 0 && (i < reps || f.lastRest.checked)) w.steps.push(mkStep('Recuperación', 'time', rt, isNaN(rs) ? 0 : rs));
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
          .map(s => mkStep(String(s.name || ''), s.type, Number(s.value), Number(s.speed) || 0));
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
