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
      hrZonesSection(S, save, field),
      paceZonesSection(S, save, field)),
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

/* ---------- Zonas de pulso ---------- */
function hrZonesSection(S, save, field) {
  const wrap = h('div', { class: 'col gap hr-zones' });
  const render = () => {
    wrap.innerHTML = '';
    const mode = S.hrZoneMode || 'max';
    wrap.append(field('Zonas de pulso', h('select', {
      value: mode, onchange: e => {
        S.hrZoneMode = e.target.value;
        // Al pasar a personalizadas se parte de las que se estaban usando.
        if (S.hrZoneMode === 'custom' && !S.hrCustom) { const c = hrZoneConfig(); S.hrCustom = { floors: [...c.floors], max: c.max }; }
        save(); render();
        if (S.hrZoneMode === 'garmin' && !S.hrGarmin && Desktop) importGarminZones(S, save, render, true);
      }
    },
      h('option', { value: 'max' }, 'Según % de la FC máxima'),
      h('option', { value: 'custom' }, 'Personalizadas'),
      h('option', { value: 'garmin' }, 'Las de mi Garmin Connect'))));

    if (mode === 'max') {
      wrap.append(field('Frecuencia cardiaca máxima (ppm)', h('input', {
        type: 'number', min: 120, max: 230, step: 1, value: S.maxHr,
        onchange: e => { const v = parseInt(e.target.value, 10); if (v >= 120 && v <= 230) { S.maxHr = v; save(); render(); } else e.target.value = S.maxHr; }
      }), 'Z1 50–60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 90–100 % de la FC máxima.'));
    } else if (mode === 'custom') {
      const c = S.hrCustom || { floors: hrZoneConfig().floors, max: hrZoneConfig().max };
      const inputs = c.floors.map((f, i) => h('input', { type: 'number', min: 40, max: 230, step: 1, value: f, title: `Inicio de la zona ${i + 1}` }));
      const maxIn = h('input', { type: 'number', min: 100, max: 240, step: 1, value: c.max, title: 'FC máxima' });
      const apply = () => {
        const floors = inputs.map(x => parseInt(x.value, 10)), max = parseInt(maxIn.value, 10);
        const ok = floors.every(v => v >= 40 && v <= 230) && floors.every((v, i) => i === 0 || v > floors[i - 1]) && max > floors[4];
        if (!ok) { toast('Cada zona tiene que empezar por encima de la anterior, y la FC máxima por encima de Z5', 'warn'); render(); return; }
        S.hrCustom = { floors, max }; save(); render();
      };
      [...inputs, maxIn].forEach(x => x.addEventListener('change', apply));
      wrap.append(h('div', { class: 'f-label' }, 'Pulso (ppm) en el que empieza cada zona'),
        h('div', { class: 'zone-inputs' },
          inputs.map((x, i) => h('label', { style: { '--zc': ZONE_COLORS[i] } }, h('b', {}, `Z${i + 1}`), x)),
          h('label', {}, h('b', {}, 'Máx.'), maxIn)));
    } else {
      const g = S.hrGarmin;
      if (!Desktop) wrap.append(h('small', { class: 'muted' }, 'Solo disponible en la app de escritorio.'));
      else {
        const btn = h('button', { class: 'btn' }, g ? 'Volver a importar' : 'Importar de Garmin Connect');
        btn.onclick = () => importGarminZones(S, save, render, false, btn);
        wrap.append(h('div', { class: 'row gap wrap' }, btn,
          h('small', { class: 'muted' }, g ? `Importadas el ${fmtDate(g.importedAt)} · ${g.sport === 'RUNNING' ? 'zonas de carrera' : 'zonas generales'}${g.method ? ' · ' + zoneMethodName(g.method) : ''}` : 'Aún no se han importado.')));
        wrap.append(h('small', { class: 'muted' }, 'Necesita la sesión de Garmin iniciada (más abajo). Se actualizan solas cada día al abrir la app, por si las cambias en Garmin.'));
      }
      if (!g) { wrap.append(h('small', { class: 'muted' }, 'Mientras tanto se usan las zonas según % de la FC máxima.')); }
    }
    wrap.append(zoneTable());
  };
  render();
  return wrap;
}

function zoneMethodName(m) {
  return { HR_MAX_BASED: '% FC máxima', HR_RESERVE: '% FC de reserva', LACTATE_THRESHOLD: '% umbral de lactato' }[m] || m;
}

function zoneTable(ranges = hrZoneRanges().map(r => `${r} ppm`)) {
  return h('div', { class: 'zone-table' }, ZONE_COLORS.map((col, i) =>
    h('div', { class: 'zone-row', style: { '--zc': col } }, h('b', {}, `Z${i + 1}`), h('span', {}, ZONE_NAMES[i]), h('span', { class: 'rng' }, ranges[i]))));
}

/* ---------- Zonas de ritmo (colores de los pasos por ritmo) ---------- */
function paceZonesSection(S, save, field) {
  const wrap = h('div', { class: 'col gap hr-zones' });
  const fmt = sec => fmtTime(sec).replace(/^0/, '');
  const render = () => {
    wrap.innerHTML = '';
    const mode = S.paceZoneMode || 'threshold';
    wrap.append(field('Zonas de ritmo', h('select', {
      value: mode, onchange: e => {
        S.paceZoneMode = e.target.value;
        if (S.paceZoneMode === 'custom' && !S.paceCustom) S.paceCustom = [...paceZoneConfig().starts];
        save(); render();
      }
    }, h('option', { value: 'threshold' }, 'Calculadas desde mi ritmo umbral'), h('option', { value: 'custom' }, 'Personalizadas')),
      'Dan color a los pasos por ritmo en el gráfico del entrenamiento.'));
    if (mode === 'threshold') {
      wrap.append(field('Ritmo umbral (min/km)', h('input', {
        type: 'text', value: fmt(S.thresholdPace || 300),
        onchange: e => {
          const sec = parseTime(e.target.value);
          if (sec >= 150 && sec <= 900) { S.thresholdPace = sec; save(); render(); }
          else { toast('Escribe el ritmo como minutos:segundos por km, p. ej. 5:00', 'warn'); e.target.value = fmt(S.thresholdPace || 300); }
        }
      }), 'El ritmo que podrías aguantar corriendo fuerte durante unos 50–60 minutos (algo más lento que tu ritmo de 10 km).'));
    } else {
      const st = S.paceCustom || paceZoneConfig().starts;
      const inputs = st.map((sec, i) => h('input', { type: 'text', value: fmt(sec), title: `Ritmo en el que empieza la zona ${i + 2}` }));
      inputs.forEach(x => x.addEventListener('change', () => {
        const v = inputs.map(x => parseTime(x.value));
        const ok = v.every(s => s >= 120 && s <= 1200) && v.every((s, i) => i === 0 || s < v[i - 1]);
        if (!ok) { toast('Cada zona tiene que empezar en un ritmo más rápido que la anterior (p. ej. 6:30, 5:40, 5:15, 4:55)', 'warn'); render(); return; }
        S.paceCustom = v; save(); render();
      }));
      wrap.append(h('div', { class: 'f-label' }, 'Ritmo (min/km) en el que empieza cada zona'),
        h('div', { class: 'zone-inputs four' }, inputs.map((x, i) => h('label', { style: { '--zc': ZONE_COLORS[i + 1] } }, h('b', {}, `Z${i + 2}`), x))),
        h('small', { class: 'muted' }, 'Z1 es todo lo que sea más lento que el inicio de Z2.'));
    }
    wrap.append(zoneTable(paceZoneRanges()));
  };
  render();
  return wrap;
}

/** Importa las zonas de Garmin Connect. silent: sin avisos si no hay sesión (p. ej. al arrancar). */
async function importGarminZones(S, save, render, silent, btn) {
  if (!Desktop) return;
  if (btn) btn.disabled = true;
  try {
    const z = await Desktop.integrations.garminHrZones();
    S.hrGarmin = { ...z, importedAt: Date.now() };
    save();
    if (!silent || btn) toast(`Zonas de Garmin importadas: ${z.floors.join(' · ')} ppm`);
    log(`Zonas de pulso de Garmin (${z.sport}, ${z.method || '?'}): ${z.floors.join(', ')} · máx ${z.max || '?'}`);
  } catch (e) {
    log('No se pudieron importar las zonas de Garmin: ' + e.message);
    if (!silent) toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (render) render();
  }
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
