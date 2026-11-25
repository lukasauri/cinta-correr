'use strict';
/* Funciones de la app de escritorio (Electron): selector Bluetooth, FIT y subidas a Garmin / Strava */

const Desktop = window.cintapc || null;
let integrationsStatus = null;
let uploadJobs = [];

/* ---------- Selector de dispositivos Bluetooth ---------- */
function closeBleChooser() { const dlg = $('#dlgBle'); if (dlg && dlg.open) dlg.close(); }

function openBleChooser() {
  const dlg = $('#dlgBle');
  $('#bleList').innerHTML = '';
  $('#bleList').append(h('div', { class: 'muted' }, 'Buscando dispositivos…'));
  if (!dlg.open) dlg.showModal();
}

/**
 * Ejecuta una búsqueda Bluetooth (requestDevice) con el selector propio de la app. El selector se abre
 * ya (aunque no aparezca nada se puede cancelar) y se cierra al terminar, se elija o no.
 */
let bleScanSeen = false, bleUserCancelled = false;
async function withBleChooser(run) {
  if (!Desktop) return run();
  bleScanSeen = false; bleUserCancelled = false;
  Desktop.ble.prepare().catch(() => { });
  openBleChooser();
  try { return await run(); }
  catch (e) {
    // Si la búsqueda termina sin haber llegado a escanear y sin que el usuario cancele, Windows no
    // la ha dejado empezar (Bluetooth apagado o su servicio detenido): Chromium lo da como "cancelado".
    if (e && e.name === 'NotFoundError' && !bleScanSeen && !bleUserCancelled) {
      throw new Error('No se pudo buscar por Bluetooth. Comprueba que el Bluetooth de Windows está activado (Configuración > Bluetooth y dispositivos) y vuelve a intentarlo.');
    }
    throw e;
  }
  finally { closeBleChooser(); }
}

function setupBleChooser() {
  if (!Desktop) return;
  const dlg = $('#dlgBle'), list = $('#bleList');
  Desktop.ble.onScanResults(devs => {
    bleScanSeen = true;
    if (!dlg.open) return; // la búsqueda ya terminó o se canceló
    list.innerHTML = '';
    if (!devs.length) list.append(h('div', { class: 'muted' }, 'Buscando dispositivos…'));
    devs.forEach(d => list.append(h('button', {
      class: 'ble-item', onclick: () => { closeBleChooser(); Desktop.ble.choose(d.id); }
    }, h('b', {}, d.name || '(sin nombre)'), h('small', { class: 'muted' }, d.id))));
  });
  $('#btnBleCancel').onclick = () => { bleUserCancelled = true; closeBleChooser(); Desktop.ble.choose(''); };
  dlg.addEventListener('cancel', () => { bleUserCancelled = true; Desktop.ble.choose(''); });
}

/* ---------- Guardado del FIT y subida automática ---------- */
function activityDescription(sum) {
  const km = (sum.dist / 1000).toFixed(2).replace('.', ',');
  const pace = fmtPace(sum.elapsed ? sum.dist / sum.elapsed * 3.6 : 0);
  const parts = [`${km} km en cinta en ${fmtTime(sum.elapsed)} (ritmo medio ${pace} /km)`];
  if (sum.avgHr) parts.push(`Pulso medio ${sum.avgHr} ppm`);
  parts.push('Registrado con CintaPC');
  return parts.join(' · ');
}

async function saveActivityFile(sum) {
  const samples = Store.get('sess.' + sum.id, []);
  return Desktop.activities.save({
    id: sum.id, name: sum.name, description: activityDescription(sum),
    start: sum.start, end: sum.end || sum.start + sum.elapsed * 1000,
    elapsed: sum.elapsed, dist: sum.dist, kcal: sum.kcal, samples
  });
}

function uploadPlan() { return { garmin: !!App.settings.uploadGarmin, strava: !!App.settings.uploadStrava }; }

/** Tras guardar una sesión: crea el FIT y, si está activado, la sube. */
async function desktopAfterSave(sum) {
  if (!Desktop) return;
  try { await saveActivityFile(sum); }
  catch (e) { toast('No se pudo crear el archivo FIT: ' + e.message, 'error'); return; }
  const plan = uploadPlan();
  if (plan.garmin || plan.strava) {
    try { uploadJobs = await Desktop.uploads.enqueue(sum.id, plan); refreshUploadPanels(); }
    catch (e) { toast(e.message, 'error'); }
  }
}

async function uploadNow(sum) {
  const plan = uploadPlan();
  if (!plan.garmin && !plan.strava) { toast('Activa la subida a Garmin Connect o Strava en Ajustes', 'warn'); switchView('settings'); return; }
  try {
    await saveActivityFile(sum);
    uploadJobs = await Desktop.uploads.enqueue(sum.id, plan);
    refreshUploadPanels();
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------- Estado de las subidas ---------- */
const TARGET_NAMES = { garmin: 'Garmin Connect', strava: 'Strava', stravaCheck: 'Strava (vía Garmin)' };
const STATUS_ICONS = { pending: '⏳', running: '⏳', done: '✅', failed: '⚠️', needsAuth: '🔑' };

function uploadPanel(sum) {
  const el = h('div', { class: 'upload-panel', 'data-id': sum.id });
  fillUploadPanel(el, sum);
  return el;
}

function fillUploadPanel(el, sum) {
  el.innerHTML = '';
  const jobs = uploadJobs.filter(j => j.activityId === sum.id);
  el.append(h('div', { class: 'f-label' }, 'Garmin Connect y Strava'));
  if (!jobs.length) {
    const plan = uploadPlan();
    el.append(h('div', { class: 'row gap wrap' },
      h('span', { class: 'muted' }, plan.garmin || plan.strava ? 'Esta sesión no se ha subido.' : 'Subida automática desactivada (Ajustes).'),
      h('button', { class: 'btn', onclick: () => uploadNow(sum) }, '⬆ Subir ahora')));
    return;
  }
  jobs.forEach(j => el.append(h('div', { class: 'upload-row ' + j.status },
    h('span', {}, STATUS_ICONS[j.status] || ''),
    h('b', {}, TARGET_NAMES[j.target] || j.target),
    h('span', { class: 'muted grow' }, j.message),
    j.url ? h('button', { class: 'mini', onclick: () => window.open(j.url, '_blank') }, 'Ver') : null,
    j.status === 'needsAuth' ? h('button', { class: 'mini', onclick: () => switchView('settings') }, 'Ajustes') : null,
    (j.status === 'failed' || j.status === 'needsAuth' || (j.status === 'pending' && j.attempts > 0))
      ? h('button', { class: 'mini', onclick: () => Desktop.uploads.retry(j.id).then(l => { uploadJobs = l; refreshUploadPanels(); }) }, 'Reintentar') : null)));
}

function refreshUploadPanels() {
  const hist = loadHistory();
  $$('.upload-panel').forEach(el => {
    const sum = hist.find(x => x.id === el.dataset.id);
    if (sum) fillUploadPanel(el, sum);
  });
}

/** Botones de exportación/subida para el historial y el resumen. */
function desktopExportButtons(sum) {
  return h('div', { class: 'col gap' },
    uploadPanel(sum),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn', onclick: () => exportTCX(sum) }, '⬇ Descargar TCX'),
      h('button', { class: 'btn', onclick: () => saveActivityFile(sum).then(() => Desktop.activities.showFit(sum.id)).catch(e => toast(e.message, 'error')) }, '📁 Mostrar archivo FIT')));
}

/* ---------- Ajustes de Garmin y Strava ---------- */
function integrationsCard() {
  const card = h('div', { class: 'card', id: 'integrationsCard' }, h('h3', {}, 'Garmin Connect y Strava'));
  if (!Desktop) {
    card.append(h('p', { class: 'muted small' }, 'La subida automática solo funciona en la app de escritorio. Ábrela con "Iniciar CintaPC.cmd".'));
    return card;
  }
  card.append(h('div', { class: 'muted' }, 'Cargando…'));
  Desktop.integrations.status().then(st => { integrationsStatus = st; fillIntegrationsCard(); }).catch(e => toast(e.message, 'error'));
  return card;
}

function fillIntegrationsCard() {
  const card = $('#integrationsCard');
  if (!card || !integrationsStatus) return;
  const S = App.settings, st = integrationsStatus;
  const busy = (btn, fn) => async () => {
    btn.disabled = true;
    try { integrationsStatus = await fn(); fillIntegrationsCard(); }
    catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
  };
  const toggle = (key, label) => h('label', { class: 'field check' },
    h('input', { type: 'checkbox', checked: S[key], onchange: e => { S[key] = e.target.checked; Store.set('settings', S); } }), h('span', {}, label));
  card.innerHTML = '';
  card.append(h('h3', {}, 'Garmin Connect y Strava'));

  // Garmin
  const gLogin = h('button', { class: 'btn primary' }, 'Iniciar sesión en Garmin');
  gLogin.onclick = busy(gLogin, async () => {
    const r = await Desktop.integrations.garminLogin();
    if (r.garmin.loggedIn) { S.uploadGarmin = true; Store.set('settings', S); toast('Sesión de Garmin Connect iniciada'); }
    return r;
  });
  const gOut = h('button', { class: 'btn' }, 'Cerrar sesión');
  gOut.onclick = busy(gOut, () => Desktop.integrations.garminLogout());
  const gCheck = h('button', { class: 'btn' }, 'Comprobar');
  gCheck.onclick = busy(gCheck, async () => { const r = await Desktop.integrations.garminCheck(); toast(r.garmin.loggedIn ? 'La sesión de Garmin funciona' : 'La sesión de Garmin ha caducado', r.garmin.loggedIn ? 'info' : 'warn'); return r; });
  card.append(h('div', { class: 'svc garmin-svc' },
    h('div', { class: 'row gap wrap' },
      h('b', { class: 'grow' }, 'Garmin Connect'),
      h('span', { class: 'pill ' + (st.garmin.loggedIn ? 'ok' : '') }, st.garmin.loggedIn ? `Conectado${st.garmin.displayName ? ' como ' + st.garmin.displayName : ''}` : 'Sin sesión')),
    h('div', { class: 'row gap wrap' }, st.garmin.loggedIn ? [gCheck, gOut] : gLogin),
    toggle('uploadGarmin', 'Subir automáticamente cada sesión a Garmin Connect'),
    h('small', { class: 'muted' }, 'Método no oficial (el mismo que Rodillo Virtual): se usa el inicio de sesión de la app móvil de Garmin. La contraseña se escribe en la página de Garmin y la app no la guarda. Si Garmin cambia su sistema, puede dejar de funcionar.')));

  // Strava
  const svc = h('div', { class: 'svc strava-svc' },
    h('div', { class: 'row gap wrap' },
      h('b', { class: 'grow' }, 'Strava'),
      h('span', { class: 'pill ' + (st.strava.connected ? 'ok' : '') }, st.strava.connected ? `Conectado${st.strava.athleteName ? ' como ' + st.strava.athleteName : ''}` : st.strava.configured ? 'Sin conectar' : 'Sin configurar')));
  if (!st.strava.configured) {
    const reload = h('button', { class: 'btn' }, 'Ya he puesto las claves');
    reload.onclick = busy(reload, async () => { const r = await Desktop.integrations.reloadConfig(); if (!r.strava.configured) toast('No se encuentran las claves en config.env', 'warn'); return r; });
    svc.append(
      h('ol', { class: 'small steps-list' },
        h('li', {}, 'Entra en ', h('a', { href: 'https://www.strava.com/settings/api', target: '_blank' }, 'strava.com/settings/api'), ' y crea una aplicación (nombre libre, sitio web cualquiera).'),
        h('li', {}, 'En "Authorization Callback Domain" pon: ', h('code', {}, 'localhost')),
        h('li', {}, 'Pulsa "Abrir config.env", pega el Client ID y el Client Secret y guarda.'),
        h('li', {}, 'Pulsa "Ya he puesto las claves".')),
      h('div', { class: 'row gap wrap' }, h('button', { class: 'btn', onclick: () => Desktop.integrations.openConfig() }, 'Abrir config.env'), reload));
  } else if (!st.strava.connected) {
    const conn = h('button', { class: 'btn primary' }, 'Conectar con Strava');
    conn.onclick = busy(conn, async () => {
      toast('Autoriza CintaPC en la página de Strava que se ha abierto en el navegador');
      const r = await Desktop.integrations.connectStrava();
      if (r.strava.connected) { S.uploadStrava = true; Store.set('settings', S); toast('Strava conectado'); }
      return r;
    });
    svc.append(h('div', { class: 'row gap wrap' }, conn, h('button', { class: 'btn', onclick: () => Desktop.integrations.openConfig() }, 'Abrir config.env')));
  } else {
    const disc = h('button', { class: 'btn' }, 'Desconectar');
    disc.onclick = busy(disc, () => Desktop.integrations.disconnectStrava());
    svc.append(h('div', { class: 'row gap wrap' }, disc));
  }
  svc.append(toggle('uploadStrava', 'Subir automáticamente cada sesión a Strava'),
    h('small', { class: 'muted' }, 'Con Garmin también activado, primero se espera a que Garmin la pase a Strava (si tienes las cuentas enlazadas) y solo se sube directamente si no llega en unos 10 minutos. Así no hay duplicados.'));
  if (st.strava.insecureStorage) svc.append(h('small', { class: 'muted' }, 'Aviso: Windows no ofrece cifrado; habrá que volver a conectar al reiniciar.'));
  card.append(svc);
}

/* ---------- Versión y actualizaciones ---------- */
const UPDATE_REPO = 'lukasauri/cinta-correr';
let appVersion = null;

function newerVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** Versión publicada más reciente en GitHub (las actualizaciones se instalan al abrir la app). */
async function checkForUpdate(manual) {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
    const latest = String((await res.json()).tag_name || '').replace(/^v/, '');
    if (appVersion && latest && newerVersion(latest, appVersion)) {
      toast(`Hay una versión nueva de CintaPC (${latest}). Cierra la app y vuelve a abrirla para instalarla.`, 'warn');
      return latest;
    }
    if (manual) toast('CintaPC está al día');
  } catch (e) {
    if (manual) toast('No se pudo comprobar: ' + e.message, 'error');
  }
  return null;
}

function aboutCard() {
  const card = h('div', { class: 'card' }, h('h3', {}, 'Acerca de CintaPC'));
  if (!Desktop) { card.append(h('p', { class: 'muted small' }, 'Versión web.')); return card; }
  card.append(
    h('div', {}, 'Versión ', h('b', {}, appVersion || '…')),
    h('p', { class: 'muted small' }, 'La app busca actualizaciones cada vez que se abre y las instala sola. Tus datos (entrenamientos, historial, ajustes y cuentas) se conservan.'),
    h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: () => checkForUpdate(true) }, 'Buscar actualizaciones')));
  return card;
}

function setupDesktop() {
  if (!Desktop) return;
  document.body.classList.add('desktop');
  Desktop.version().then(v => {
    appVersion = v;
    document.title = `CintaPC ${v}`;
    const seen = Store.get('lastVersion', null);
    if (seen && seen !== v) toast(`CintaPC se ha actualizado a la versión ${v}`);
    Store.set('lastVersion', v);
    checkForUpdate(false);
  }).catch(() => { });
  setupBleChooser();
  Desktop.uploads.list().then(l => { uploadJobs = l; refreshUploadPanels(); }).catch(() => { });
  Desktop.uploads.onChange(l => {
    const before = new Map(uploadJobs.map(j => [j.id, j.status]));
    uploadJobs = l;
    refreshUploadPanels();
    l.forEach(j => { if (j.status === 'done' && before.get(j.id) && before.get(j.id) !== 'done' && j.url) toast(`${TARGET_NAMES[j.target]}: ${j.message}`); });
  });
  Desktop.integrations.onChange(st => { integrationsStatus = st; fillIntegrationsCard(); });
}
