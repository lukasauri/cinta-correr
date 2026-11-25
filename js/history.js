'use strict';
/* Historial de sesiones y exportación TCX (Strava / Garmin Connect) */

const STRAVA_UPLOAD = 'https://www.strava.com/upload/select';
const GARMIN_IMPORT = 'https://connect.garmin.com/modern/import-data';

let histSel = null;

function loadHistory() { return Store.get('history', []); }

/** Guarda una sesión. samples: [segReloj, segActivos, distM, kmh, ppm] */
function saveSession(s) {
  const smp = s.samples;
  const hrVals = smp.map(p => p[4]).filter(Boolean);
  const sum = {
    // Fin = última muestra (no "ahora": una sesión recuperada tras un cierre se guarda mucho después).
    id: s.id, name: s.name, start: s.start, end: smp.length ? s.start + smp[smp.length - 1][0] * 1000 : s.start + Math.round(s.elapsed) * 1000,
    elapsed: Math.round(s.elapsed), dist: Math.round(s.dist), kcal: Math.round(s.kcal),
    avgHr: s.hrTime > 0 ? Math.round(s.hrSum / s.hrTime) : null,
    maxHr: s.hrMax || (hrVals.length ? Math.max(...hrVals) : null),
    maxSpeed: smp.length ? Math.max(...smp.map(p => p[3])) : 0,
    workoutId: s.workoutId || null,
  };
  if (!Store.set('sess.' + s.id, smp)) return null;
  const hist = loadHistory().filter(x => x.id !== s.id);
  hist.unshift(sum);
  hist.sort((a, b) => b.start - a.start);
  Store.set('history', hist);
  return sum;
}

function deleteSession(id) {
  if (Desktop) Desktop.activities.remove(id).catch(() => { });
  Store.remove('sess.' + id);
  Store.set('history', loadHistory().filter(x => x.id !== id));
}

function buildTCX(sum, samples) {
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const t0 = sum.start;
  const pts = samples.map(p => [
    '          <Trackpoint>',
    `            <Time>${iso(t0 + p[0] * 1000)}</Time>`,
    `            <DistanceMeters>${Number(p[2]).toFixed(1)}</DistanceMeters>`,
    p[4] ? `            <HeartRateBpm><Value>${p[4]}</Value></HeartRateBpm>` : null,
    `            <Extensions><ns3:TPX><ns3:Speed>${(p[3] / 3.6).toFixed(3)}</ns3:Speed></ns3:TPX></Extensions>`,
    '          </Trackpoint>'].filter(Boolean).join('\n')).join('\n');
  const hr = sum.avgHr ? `        <AverageHeartRateBpm><Value>${sum.avgHr}</Value></AverageHeartRateBpm>\n        <MaximumHeartRateBpm><Value>${sum.maxHr || sum.avgHr}</Value></MaximumHeartRateBpm>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Activities>
    <Activity Sport="Running">
      <Id>${iso(t0)}</Id>
      <Lap StartTime="${iso(t0)}">
        <TotalTimeSeconds>${sum.elapsed}</TotalTimeSeconds>
        <DistanceMeters>${sum.dist}</DistanceMeters>
        <MaximumSpeed>${((sum.maxSpeed || 0) / 3.6).toFixed(3)}</MaximumSpeed>
        <Calories>${sum.kcal}</Calories>
${hr}        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${pts}
        </Track>
      </Lap>
      <Notes>${escapeXml(sum.name)} (cinta de correr - CintaPC)</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

function tcxFileName(sum) {
  const d = new Date(sum.start);
  return `cinta_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.tcx`;
}

function exportTCX(sum) {
  const smp = Store.get('sess.' + sum.id, []);
  download(tcxFileName(sum), buildTCX(sum, smp), 'application/vnd.garmin.tcx+xml');
}

function exportTo(sum, where) {
  exportTCX(sum);
  window.open(where === 'strava' ? STRAVA_UPLOAD : GARMIN_IMPORT, '_blank', 'noopener');
  toast(`Archivo TCX descargado. Súbelo en la página de ${where === 'strava' ? 'Strava' : 'Garmin Connect'} que se ha abierto.`);
}

function exportButtons(sum) {
  if (Desktop) return desktopExportButtons(sum);
  return h('div', { class: 'row gap wrap' },
    h('button', { class: 'btn', onclick: () => exportTCX(sum) }, '⬇ Descargar TCX'),
    h('button', { class: 'btn strava', onclick: () => exportTo(sum, 'strava') }, 'Subir a Strava'),
    h('button', { class: 'btn garmin', onclick: () => exportTo(sum, 'garmin') }, 'Subir a Garmin Connect'));
}

function statGrid(sum) {
  const items = [
    ['Tiempo', fmtTime(sum.elapsed)],
    ['Distancia', `${(sum.dist / 1000).toFixed(2)} km`],
    ['Ritmo medio', `${fmtPace(sum.elapsed ? sum.dist / sum.elapsed * 3.6 : 0)} /km`],
    ['Vel. media', `${(sum.elapsed ? sum.dist / sum.elapsed * 3.6 : 0).toFixed(1)} km/h`],
    ['Vel. máx.', `${(sum.maxSpeed || 0).toFixed(1)} km/h`],
    ['Calorías', `${sum.kcal} kcal`],
    ['Pulso medio', sum.avgHr ? `${sum.avgHr} ppm` : '—'],
    ['Pulso máx.', sum.maxHr ? `${sum.maxHr} ppm` : '—'],
  ];
  return h('div', { class: 'stats' }, items.map(([k, v]) => h('div', { class: 'stat' }, h('small', {}, k), h('b', {}, v))));
}

function renderHistory() {
  const hist = loadHistory();
  const box = $('#histList');
  box.innerHTML = '';

  const weekAgo = Date.now() - 7 * 864e5;
  const wk = hist.filter(x => x.start >= weekAgo);
  const tot = arr => ({ n: arr.length, d: arr.reduce((a, x) => a + x.dist, 0), t: arr.reduce((a, x) => a + x.elapsed, 0) });
  const a = tot(wk), b = tot(hist);
  box.append(h('div', { class: 'stats compact' },
    h('div', { class: 'stat' }, h('small', {}, 'Últimos 7 días'), h('b', {}, `${(a.d / 1000).toFixed(1)} km`), h('small', {}, `${a.n} sesiones · ${fmtTime(a.t)}`)),
    h('div', { class: 'stat' }, h('small', {}, 'Total'), h('b', {}, `${(b.d / 1000).toFixed(1)} km`), h('small', {}, `${b.n} sesiones · ${fmtTime(b.t)}`))));

  if (!hist.length) box.append(h('div', { class: 'empty' }, 'Aún no hay sesiones. ¡A correr!'));
  hist.forEach(x => box.append(h('div', {
    class: 'wo-item' + (x.id === histSel ? ' active' : ''),
    onclick: () => { histSel = x.id; renderHistory(); }
  },
    h('div', { class: 'wo-name' }, x.name),
    h('div', { class: 'wo-meta' }, `${fmtDate(x.start)} · ${fmtTime(x.elapsed)} · ${(x.dist / 1000).toFixed(2)} km`))));

  const det = $('#histDetail');
  det.innerHTML = '';
  const sum = hist.find(x => x.id === histSel) || hist[0];
  if (!sum) return;
  histSel = sum.id;
  $$('.wo-item', box).forEach((el, i) => el.classList.toggle('active', hist[i] && hist[i].id === sum.id));
  const smp = Store.get('sess.' + sum.id, []);
  const cv = h('canvas', { class: 'preview tall' });
  det.append(
    h('div', { class: 'row gap wrap' },
      h('h2', { class: 'grow' }, sum.name),
      h('button', {
        class: 'btn danger', onclick: () => {
          if (!confirm('¿Eliminar esta sesión del historial?')) return;
          deleteSession(sum.id); histSel = null; renderHistory();
        }
      }, 'Eliminar')),
    h('div', { class: 'muted' }, fmtDate(sum.start)),
    statGrid(sum),
    h('div', { class: 'legend' }, h('span', { class: 'lg acc' }, 'Velocidad (km/h)'), h('span', { class: 'lg hr' }, 'Pulso (ppm)')),
    cv,
    exportButtons(sum),
    ...(Desktop ? [] : [h('p', { class: 'muted small' }, 'Strava y Garmin no permiten subir archivos directamente desde una app local sin registrarla como aplicación de desarrollador; por eso se descarga el TCX y se abre su página de subida. En Garmin Connect puedes cambiar después el tipo de actividad a "Carrera en cinta".')]));
  requestAnimationFrame(() => drawLineChart(cv, {
    xMax: sum.elapsed,
    series: [
      { pts: smp.map(p => [p[1], p[3]]), color: cssVar('--accent'), axis: 0, min: 0 },
      { pts: smp.filter(p => p[4]).map(p => [p[1], p[4]]), color: cssVar('--hr'), axis: 1 },
    ]
  }));
}

function showSummary(sum) {
  const dlg = $('#dlgSummary');
  const body = dlg.querySelector('.body');
  body.innerHTML = '';
  body.append(h('h2', {}, '¡Sesión terminada!'), h('div', { class: 'muted' }, sum.name), statGrid(sum), exportButtons(sum));
  dlg.showModal();
}
