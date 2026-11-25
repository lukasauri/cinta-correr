'use strict';
/* Vista de ajustes */

function renderSettings() {
  const S = App.settings;
  const box = $('#settingsBox');
  box.innerHTML = '';
  const save = () => { Store.set('settings', S); renderPresets(); resetIdleTarget(); };
  const field = (label, input, hint) => h('label', { class: 'field' }, h('span', { class: 'f-label' }, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  const num = (key, label, attrs, hint) => field(label, h('input', {
    type: 'number', value: S[key], ...attrs,
    onchange: e => { const v = parseFloat(e.target.value); if (!isNaN(v)) { S[key] = v; save(); } }
  }), hint);
  const chk = (key, label, hint) => h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: S[key], onchange: e => { S[key] = e.target.checked; save(); } }), h('span', {}, label), hint ? h('small', { class: 'muted' }, hint) : null);
  const sel = (key, label, opts, hint) => field(label, h('select', { value: S[key], onchange: e => { S[key] = e.target.value; save(); } }, opts.map(([v, t]) => h('option', { value: v }, t))), hint);
  const card = (title, ...kids) => h('div', { class: 'card' }, h('h3', {}, title), ...kids);

  const logBox = h('textarea', { id: 'logBox', readonly: true, rows: 12 });
  logBox.value = App.logLines.join('\n');

  box.append(
    card('Perfil',
      num('weight', 'Peso (kg)', { min: 30, max: 200, step: 1 }, 'Se usa para estimar las calorías.'),
      num('maxHr', 'Frecuencia cardiaca máxima (ppm)', { min: 120, max: 230, step: 1 }, 'Define las zonas de pulso (Z1 < 60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 > 90 %).')),
    integrationsCard(),
    card('Cinta',
      field('Unidades', h('select', { value: S.workoutUnit, onchange: e => setUnits(e.target.value) },
        h('option', { value: 'speed' }, 'Velocidad en km/h'),
        h('option', { value: 'pace' }, 'Ritmo en min/km')),
        'Se usa en toda la app: objetivo y botones mientras corres, datos de la pantalla y entrenamientos.'),
      ...(isPace() ? [
        field('Ritmo inicial en carrera libre (min/km)', h('input', {
          type: 'text', value: fmtTime(S.freeStartPace || 360).replace(/^0/, ''),
          onchange: e => {
            const sec = parseTime(e.target.value);
            if (sec >= 120 && sec <= 3600) { S.freeStartPace = sec; save(); }
            e.target.value = fmtTime(S.freeStartPace || 360).replace(/^0/, '');
          }
        }), 'Con el que arranca la cinta en carrera libre. Antes de pulsar Iniciar también se puede cambiar con − / +.'),
        num('paceStep', 'Salto de los botones + / − y flechas (segundos por km)', { min: 1, max: 60, step: 1 }, 'Con 5: 5:30 → 5:25 (más rápido) o 5:35 (más despacio).'),
        field('Botones de ritmo rápido (min/km)', h('input', {
          type: 'text', value: (S.pacePresets || []).map(fmtTime).map(t => t.replace(/^0/, '')).join(' '),
          onchange: e => {
            const arr = e.target.value.split(/[;\s]+/).filter(Boolean).map(x => parseTime(x)).filter(x => x >= 120 && x <= 3600);
            S.pacePresets = arr; e.target.value = arr.map(fmtTime).map(t => t.replace(/^0/, '')).join(' '); save();
          }
        }), 'Separados por espacios, p. ej.: 7:00 6:30 6:00 5:30 5:00'),
      ] : [
        num('freeStartSpeed', 'Velocidad inicial en carrera libre (km/h)', { min: 0.5, max: 20, step: 0.1 }),
        num('speedStep', 'Incremento de los botones + / − y flechas (km/h)', { min: 0.1, max: 2, step: 0.1 }),
        field('Botones de velocidad rápida (km/h)', h('input', {
          type: 'text', value: S.presets.join(' '),
          onchange: e => {
            const arr = e.target.value.split(/[;\s]+/).map(x => parseFloat(x.replace(',', '.'))).filter(x => x > 0 && x <= 25);
            S.presets = arr; e.target.value = arr.join(' '); save();
          }
        }), 'Separadas por espacios, p. ej.: 4 6 8 10 12'),
      ]),
      sel('distSource', 'Distancia', [['calc', 'Calculada por la app (a partir de la velocidad)'], ['machine', 'La que envía la cinta']]),
      sel('kcalSource', 'Calorías', [['calc', 'Calculadas por la app (peso + velocidad)'], ['machine', 'Las que envía la cinta']]),
      chk('showAllDevices', 'Mostrar todos los dispositivos Bluetooth al buscar la cinta', 'Actívalo si tu cinta no aparece en la lista.'),
      chk('autoReconnect', 'Reconectar automáticamente si se pierde la conexión')),
    card('Avisos',
      chk('beeps', 'Pitidos (cuenta atrás y cambios de paso)'),
      chk('voice', 'Voz (anuncia cada paso del entrenamiento)'),
      num('countdown', 'Cuenta atrás antes de arrancar (segundos)', { min: 0, max: 10, step: 1 })),
    card('Datos',
      h('p', { class: 'muted small' }, 'Los entrenamientos, el historial y los ajustes se guardan dentro de la app. Haz copias de seguridad de vez en cuando (también sirven para pasar datos de un PC a otro).'),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn', onclick: exportBackup }, '⬇ Exportar copia de seguridad'),
        h('button', { class: 'btn', onclick: importBackup }, '⬆ Importar copia'),
        h('button', { class: 'btn danger', onclick: wipeAll }, 'Borrar todos los datos'))),
    aboutCard(),
    card('Diagnóstico',
      h('p', { class: 'muted small' }, 'Registro de conexión Bluetooth. Si la cinta no funciona, copia este texto: indica qué servicios ofrece.'),
      logBox,
      h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(App.logLines.join('\n')).then(() => toast('Registro copiado')); } }, 'Copiar registro')))
  );
}

function exportBackup() {
  const sessions = {};
  loadHistory().forEach(x => { sessions[x.id] = Store.get('sess.' + x.id, []); });
  const data = { app: 'CintaPC', version: 1, exported: new Date().toISOString(), settings: App.settings, layout: App.layout, workouts: App.workouts, history: loadHistory(), sessions };
  const d = new Date();
  download(`cintapc_copia_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`, JSON.stringify(data), 'application/json');
}

function importBackup() {
  const inp = h('input', { type: 'file', accept: '.json,application/json' });
  inp.onchange = async () => {
    try {
      const data = JSON.parse(await inp.files[0].text());
      if (data.app !== 'CintaPC') throw new Error('formato');
      if (!confirm('Se fusionarán los entrenamientos y el historial de la copia con los actuales, y se aplicarán sus ajustes y diseño. ¿Continuar?')) return;
      if (data.settings) Store.set('settings', data.settings);
      if (data.layout) Store.set('layout', data.layout);
      if (Array.isArray(data.workouts)) {
        const ids = new Set(App.workouts.map(w => w.id));
        Store.set('workouts', App.workouts.concat(data.workouts.filter(w => !ids.has(w.id))));
      }
      if (Array.isArray(data.history)) {
        const hist = loadHistory(), ids = new Set(hist.map(x => x.id));
        data.history.forEach(x => { if (!ids.has(x.id)) { hist.push(x); Store.set('sess.' + x.id, (data.sessions || {})[x.id] || []); } });
        hist.sort((a, b) => b.start - a.start);
        Store.set('history', hist);
      }
      location.reload();
    } catch (e) { toast('El archivo no es una copia válida de CintaPC', 'error'); }
  };
  inp.click();
}

function wipeAll() {
  if (!confirm('¿Borrar TODOS los datos (entrenamientos, historial, ajustes)? No se puede deshacer.')) return;
  Store.keys().forEach(k => Store.remove(k));
  location.reload();
}
