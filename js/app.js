'use strict';
/* CintaPC — lógica principal: conexión, sesión de entrenamiento y controles */

const DEFAULT_SETTINGS = {
  weight: 75, maxHr: 190, distSource: 'calc', kcalSource: 'calc',
  voice: true, beeps: true, countdown: 3,
  presets: [4, 6, 8, 10, 12], speedStep: 0.5, freeStartSpeed: 4,
  pacePresets: [420, 390, 360, 330, 300], paceStep: 5, freeStartPace: 360, // en min/km: ritmos rápidos (segundos/km) y salto de +/− (s)
  showAllDevices: false, autoReconnect: true,
  uploadGarmin: false, uploadStrava: false,
  hrZoneMode: 'max', hrCustom: null, hrGarmin: null,
  hrAutoAdjust: true, // pasos por zona de pulso: la app ajusta la velocidad (false = solo avisa)
  paceZoneMode: 'threshold', thresholdPace: 300, paceCustom: null, // zonas de ritmo: desde el ritmo umbral (s/km) o personalizadas // zonas de pulso: 'max' (% FC máx.), 'custom' o 'garmin'
  workoutUnit: 'speed', // 'speed' (km/h) o 'pace' (min/km) para escribir los entrenamientos
};

const DEFAULT_LAYOUT = {
  theme: 'dark', accent: '#22c55e', columns: 4, rowHeight: 130, fontScale: 1,
  widgets: [
    { id: 'speed', size: 'l' }, { id: 'time', size: 'm' }, { id: 'distance', size: 'm' },
    { id: 'pace', size: 's' }, { id: 'hr', size: 's' }, { id: 'kcal', size: 's' }, { id: 'stepRemaining', size: 's' },
    { id: 'step', size: 'm' }, { id: 'next', size: 'm' },
    { id: 'progress', size: 'w' }, { id: 'chart', size: 'w2' },
  ],
};

function loadLayout() {
  const l = Store.get('layout', null);
  return Object.assign(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)), l || {});
}

const App = {
  settings: Object.assign({}, DEFAULT_SETTINGS, Store.get('settings', {})),
  layout: loadLayout(),
  workouts: Store.get('workouts', null),
  treadmill: null, hrm: null,
  live: { speed: 0, hrStrap: null, hrStrapTs: 0, hrMachine: null, hrMachineTs: 0, machineDist: null, machineKcal: null },
  session: null, targetSpeed: 0, lastCmdAt: 0,
  editing: false, logLines: [], wakeLock: null, widgetEls: [],
};
if (!App.workouts) { App.workouts = sampleWorkouts(); Store.set('workouts', App.workouts); }

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('es-ES')}] ${msg}`;
  App.logLines.push(line);
  if (App.logLines.length > 500) App.logLines.shift();
  console.log(line);
  const ta = $('#logBox');
  if (ta) { ta.value = App.logLines.join('\n'); ta.scrollTop = ta.scrollHeight; }
}

/** Ejecuta una orden a la cinta capturando errores */
function safe(fn) {
  return Promise.resolve().then(fn).catch(e => { log('Error: ' + e.message); toast(e.message, 'error'); });
}
function cmd(fn) {
  App.lastCmdAt = Date.now();
  if (App.session) App.session.retried = false;
  return safe(fn);
}

function currentHr() {
  const L = App.live, now = Date.now();
  if (L.hrStrap && now - L.hrStrapTs < 5000) return L.hrStrap;
  if (L.hrMachine && now - L.hrMachineTs < 5000) return L.hrMachine;
  return null;
}

/* ---------- Dispositivos ---------- */

function attachTreadmill(t) {
  App.treadmill = t;
  t.on('data', d => {
    const L = App.live;
    if (d.speed != null) L.speed = d.speed;
    if (d.distance != null) L.machineDist = d.distance;
    if (d.kcal != null) L.machineKcal = d.kcal;
    if (d.hr) { L.hrMachine = d.hr; L.hrMachineTs = Date.now(); }
    tick();
  });
  t.on('connected', () => {
    updateChips();
    toast(`Conectado: ${t.name}`);
    const s = App.session;
    if (s && !s.paused && !s.beltPaused && App.targetSpeed > 0) cmd(() => t.setSpeed(App.targetSpeed));
  });
  t.on('disconnected', unexpected => {
    App.live.speed = 0;
    updateChips();
    if (unexpected) {
      toast('Se ha perdido la conexión con la cinta', 'warn');
      Sound.beep(300, 0.6);
      if (App.settings.autoReconnect && !t.isSim) reconnectLoop(t, 'cinta');
    }
  });
  t.on('status', st => onMachineStatus(st));
}

function attachHrm(m) {
  App.hrm = m;
  m.on('data', hr => { App.live.hrStrap = hr; App.live.hrStrapTs = Date.now(); });
  m.on('connected', () => { updateChips(); toast(`Pulsómetro conectado: ${m.name}`); });
  m.on('disconnected', unexpected => {
    App.live.hrStrap = null;
    updateChips();
    if (unexpected && App.settings.autoReconnect) reconnectLoop(m, 'pulsómetro');
  });
}

async function reconnectLoop(dev, label) {
  for (let n = 1; n <= 8; n++) {
    await sleep(2000 * n);
    if (dev.connected || (dev !== App.treadmill && dev !== App.hrm)) return;
    try { log(`Reintentando conexión con ${label} (${n})…`); await dev.reconnect(); return; }
    catch (e) { log(`Reintento fallido: ${e.message}`); }
  }
  toast(`No se pudo reconectar el ${label}. Pulsa su botón para conectarlo de nuevo.`, 'error');
}

function onMachineStatus({ op, param }) {
  const names = { 0x01: 'reinicio', 0x02: param === 2 ? 'pausa (usuario)' : 'parada (usuario)', 0x03: 'parada por llave de seguridad', 0x04: 'arranque (usuario)', 0x05: 'velocidad cambiada', 0xff: 'control perdido' };
  log(`Estado de la cinta: ${names[op] || '0x' + op.toString(16)}`);
  const s = App.session;
  if (!s) return;
  if ((op === 0x02 || op === 0x03) && !s.paused && !s.beltPaused && (op === 0x03 || Date.now() - App.lastCmdAt > 2000)) {
    autoPause(s, op === 0x03 ? '¡Llave de seguridad! Sesión en pausa' : 'Cinta detenida desde la consola: sesión en pausa');
  } else if (op === 0x04 && s.paused && s.autoPaused) {
    s.paused = false; s.autoPaused = false; s.lastTick = performance.now(); s.moved = true;
    updateControls();
  }
}

function updateChips() {
  const t = App.treadmill, m = App.hrm;
  const tc = $('#btnTreadmill'), hc = $('#btnHr');
  tc.classList.toggle('on', !!(t && t.connected));
  tc.querySelector('.lbl').textContent = t && t.connected ? t.name : 'Conectar cinta';
  hc.classList.toggle('on', !!(m && m.connected));
  hc.querySelector('.lbl').textContent = m && m.connected ? m.name : 'Conectar pulsómetro';
  renderPresets();
}

function openConnectDialog() {
  const dlg = $('#dlgConnect');
  $('#chkShowAll').checked = App.settings.showAllDevices;
  $('#btnConnBle').disabled = !navigator.bluetooth;
  dlg.showModal();
}

function connectBle() {
  const showAll = $('#chkShowAll').checked;
  App.settings.showAllDevices = showAll;
  Store.set('settings', App.settings);
  $('#dlgConnect').close();
  if (App.treadmill) App.treadmill.disconnect();
  const t = new TreadmillFTMS(log);
  attachTreadmill(t);
  withBleChooser(() => t.connect(showAll)).catch(e => {
    if (e.name === 'NotFoundError') { log('Búsqueda cancelada'); return; }
    log('Error al conectar: ' + e.message);
    toast(e.message, 'error');
    updateChips();
  });
}

function connectSim() {
  $('#dlgConnect').close();
  if (App.treadmill) App.treadmill.disconnect();
  const t = new TreadmillSim(log);
  attachTreadmill(t);
  t.connect();
}

function onTreadmillChip() {
  const t = App.treadmill;
  if (t && t.connected) {
    if (!confirm(App.session ? 'Hay una sesión en marcha. ¿Desconectar la cinta igualmente?' : `¿Desconectar ${t.name}?`)) return;
    t.disconnect();
    App.treadmill = null;
    updateChips();
  } else openConnectDialog();
}

function onHrChip() {
  const m = App.hrm;
  if (m && m.connected) {
    if (!confirm(`¿Desconectar ${m.name}?`)) return;
    m.disconnect(); App.hrm = null; updateChips();
    return;
  }
  if (!navigator.bluetooth) { toast('Este navegador no tiene Bluetooth. Usa Chrome o Edge.', 'error'); return; }
  const hrm = new HeartRateMonitor(log);
  attachHrm(hrm);
  withBleChooser(() => hrm.connect()).catch(e => {
    if (e.name !== 'NotFoundError') { log('Error pulsómetro: ' + e.message); toast(e.message, 'error'); }
    App.hrm = null; updateChips();
  });
}

/* ---------- Sesión ---------- */

function countdown(n) {
  return new Promise(resolve => {
    if (!n) return resolve();
    const ov = $('#countdown'), num = ov.querySelector('b');
    ov.hidden = false;
    let i = n;
    const step = () => {
      if (i === 0) { ov.hidden = true; return resolve(); }
      num.textContent = i; Sound.beep(660, 0.15); i--;
      setTimeout(step, 1000);
    };
    step();
  });
}

async function startSession() {
  if (App.session || App.starting) return;
  const t = App.treadmill;
  if (!t || !t.connected) { toast('Conecta primero la cinta (o usa el simulador)', 'warn'); openConnectDialog(); return; }
  const w = selectedWorkout();
  if (w && !w.steps.length) { toast('Ese entrenamiento no tiene pasos', 'warn'); return; }
  App.starting = true;
  updateControls();
  await countdown(App.settings.countdown);
  App.starting = false;

  const s = {
    id: uid(), name: w ? w.name : 'Carrera libre', workoutId: w ? w.id : null,
    steps: w ? w.steps.map(x => ({ ...x })) : null,
    start: Date.now(), elapsed: 0, dist: 0, distCalc: 0, kcal: 0, kcalCalc: 0,
    stepIdx: 0, stepElapsed: 0, stepDist: 0,
    paused: false, autoPaused: false, beltPaused: false,
    lastTick: performance.now(), samples: [], nextSample: 0,
    hrSum: 0, hrTime: 0, hrMax: 0, lastSave: Date.now(),
  };
  App.session = s;
  requestWakeLock();
  updateControls();
  Sound.beep(1200, 0.35);
  log(`Sesión iniciada: ${s.name}`);
  if (s.steps) { applyStep(true); }
  else {
    // Empieza con lo que muestra el objetivo (el ritmo inicial, o lo que se haya ajustado antes de empezar).
    if (!(App.targetSpeed > 0)) App.targetSpeed = startTarget();
    startBelt(App.targetSpeed);
  }
  renderGrid();
}

function applyStep(first) {
  const s = App.session, t = App.treadmill;
  const st = s.steps[s.stepIdx];
  if (st.type === 'dist' && !(st.speed > 0)) { gotoStep(s.stepIdx + 1); return; }
  announceStep(st);
  if (st.speed > 0) {
    App.targetSpeed = st.speed;
    const needStart = first || s.beltPaused || App.live.speed < 0.3;
    s.beltPaused = false;
    if (needStart) startBelt(st.speed);
    else if (t && t.connected) cmd(() => t.setSpeed(st.speed));
  } else {
    App.targetSpeed = 0;
    s.beltPaused = true;
    if (t && t.connected) cmd(() => t.pause());
  }
}

function describeStep(st) {
  const amount = st.type === 'time' ? speakDuration(st.value) : `${st.value} metros`;
  if (st.target === 'hr') return `${st.name ? st.name + '. ' : ''}Zona ${st.zone} de pulso durante ${amount}`;
  return st.speed > 0 ? `${st.name ? st.name + '. ' : ''}${speakTarget(st.speed)} durante ${amount}` : `${st.name ? st.name + '. ' : ''}Pausa de ${amount}`;
}

function announceStep(st) { Sound.say(describeStep(st)); }

function gotoStep(idx) {
  const s = App.session;
  if (!s || !s.steps) return;
  if (idx >= s.steps.length) {
    Sound.beep(1200, 0.6);
    Sound.say('Entrenamiento completado. ¡Buen trabajo!');
    finishSession();
    return;
  }
  s.stepIdx = Math.max(0, idx);
  s.stepElapsed = 0; s.stepDist = 0; s.lastBeep = ''; s.announced = false;
  s.hrAdjAt = 0; s.hrState = null; s.hrWarned = false;
  Sound.beep(1000, 0.25);
  applyStep(false);
  updateControls();
}

function stepTick(s, dt, dd) {
  if (!s.steps) return;
  const st = s.steps[s.stepIdx];
  if (!st) return;
  s.stepElapsed += dt;
  s.stepDist += dd;
  const rem = st.type === 'time'
    ? st.value - s.stepElapsed
    : (st.value - s.stepDist) / (Math.max(App.live.speed, 0.5) / 3.6);
  const ri = Math.ceil(rem);
  if (ri >= 1 && ri <= 3) {
    const k = s.stepIdx + ':' + ri;
    if (s.lastBeep !== k) { s.lastBeep = k; Sound.beep(660, 0.12); }
  }
  const next = s.steps[s.stepIdx + 1];
  if (next && !s.announced && ri <= 10 && estStepSec(st) >= 25) {
    s.announced = true;
    Sound.say('En diez segundos: ' + describeStep(next));
  }
  if (rem <= 0) {
    // El tiempo que sobra del paso cuenta para el siguiente (si no, el entrenamiento se alarga).
    const overflow = st.type === 'time' ? Math.min(-rem, 5) : 0;
    gotoStep(s.stepIdx + 1);
    if (App.session === s && s.steps[s.stepIdx] && s.steps[s.stepIdx].type === 'time') s.stepElapsed = overflow;
  }
}

function kcalPerSec(kmh, kg) {
  if (kmh < 0.5) return 0;
  const m = kmh * 1000 / 60;                                 // m/min
  const vo2 = kmh < 7 ? 3.5 + 0.1 * m : 3.5 + 0.2 * m;       // ACSM caminar / correr (ml/kg/min)
  return vo2 * kg / 1000 * 5 / 60;
}

function accumulate(s, dt) {
  const L = App.live, S = App.settings, v = L.speed || 0;
  s.elapsed += dt;
  const prev = s.dist;

  s.distCalc += v / 3.6 * dt;
  if (S.distSource === 'machine' && L.machineDist != null) {
    if (s.mLast == null) { s.mLast = L.machineDist; s.mAcc = s.dist; }
    if (L.machineDist >= s.mLast) s.mAcc += L.machineDist - s.mLast;
    s.mLast = L.machineDist;               // si la cinta reinicia su contador, seguimos acumulando
    s.dist = s.mAcc;
  } else s.dist = s.distCalc;

  s.kcalCalc += kcalPerSec(v, S.weight) * dt;
  if (S.kcalSource === 'machine' && L.machineKcal != null) {
    if (s.kLast == null) { s.kLast = L.machineKcal; s.kAcc = s.kcal; }
    if (L.machineKcal >= s.kLast) s.kAcc += L.machineKcal - s.kLast;
    s.kLast = L.machineKcal;
    s.kcal = s.kAcc;
  } else s.kcal = s.kcalCalc;

  const hr = currentHr();
  if (hr) { s.hrSum += hr * dt; s.hrTime += dt; s.hrMax = Math.max(s.hrMax, hr); }

  if (s.elapsed >= s.nextSample) {
    s.samples.push([Math.round((Date.now() - s.start) / 1000), Math.round(s.elapsed), Math.round(s.dist), Math.round(v * 100) / 100, hr || 0, s.steps ? s.stepIdx : 0]);
    s.nextSample += 2;
  }
  stepTick(s, dt, Math.max(0, s.dist - prev));
}

/** Arranca la cinta (si hace falta) y fija la velocidad. Marca el arranque para el vigilante. */
function startBelt(kmh) {
  const t = App.treadmill, s = App.session;
  if (!t || !t.connected) return Promise.resolve();
  if (s) { s.startAt = Date.now(); s.moved = false; s.retried = false; s.stoppedSince = null; }
  return cmd(async () => { await t.start(); await t.setSpeed(kmh); });
}

function autoPause(s, msg) {
  s.paused = true; s.autoPaused = true; s.sawStop = false; s.stoppedSince = null;
  log(msg);
  toast(msg, 'warn');
  updateControls();
}

/* ---------- Pasos por zona de pulso: ajuste automático de la velocidad ---------- */
const HR_CTRL = {
  firstAfterS: 30,   // el pulso tarda en responder: primer ajuste a los 30 s de empezar el paso
  everyS: 20,        // y después, como mucho uno cada 20 s
  trendBpm: 3,       // si el pulso ya va camino de la zona (±3 ppm en ~15 s), se espera en vez de corregir más
  up: 0.2,           // subir poco a poco (0,4 si está a más de 10 ppm por debajo)
  down: 0.3,         // bajar algo más rápido (0,6 si está a más de 8 ppm por encima)
  bigDown: 0.6,
  minKmh: 3,         // nunca por debajo de paso de caminar
};

/**
 * Mantiene el pulso en la zona del paso cambiando la velocidad. Seguridad:
 *  - nunca más rápido que el máximo del paso (ni que el máximo de la cinta);
 *  - sin pulso (o un valor imposible) no se toca nada;
 *  - usa la media de los últimos 10 s para no reaccionar a lecturas sueltas;
 *  - si el pulso ya se está moviendo hacia la zona, espera (el pulso va con retraso respecto a la velocidad).
 */
function hrControl(s) {
  const st = s.steps && s.steps[s.stepIdx];
  if (!st || st.target !== 'hr' || s.paused || s.beltPaused) return;
  const t = App.treadmill;
  if (!t || !t.connected) return;
  const now = Date.now(), hr = currentHr();
  const valid = hr && hr >= 40 && hr <= 230;
  s.hrBuf = (s.hrBuf || []).filter(x => now - x[0] < 20000);
  if (valid) s.hrBuf.push([now, hr]);
  if (s.stepElapsed < HR_CTRL.firstAfterS) return;
  if (!valid) {
    // Sin pulso ahora mismo: no se ajusta con lecturas antiguas.
    s.hrBuf = [];
    s.hrState = 'nohr';
    if (!s.hrWarned) { s.hrWarned = true; toast('Sin pulso: se mantiene la velocidad. Conecta el pulsómetro.', 'warn'); log('Paso por pulso sin datos de pulso: velocidad fija'); }
    return;
  }
  s.hrWarned = false;
  if (now - (s.hrAdjAt || 0) < HR_CTRL.everyS * 1000) return;
  const mean = (from, to) => { const xs = s.hrBuf.filter(x => now - x[0] >= from && now - x[0] < to); return xs.length ? xs.reduce((a, x) => a + x[1], 0) / xs.length : null; };
  const avg = mean(0, 10000);
  const old = mean(12000, 20000);
  const trend = old === null ? 0 : (mean(0, 5000) ?? avg) - old; // ppm de cambio en ~15 s
  const { floors, max } = hrZoneConfig();
  const lo = floors[st.zone - 1], hi = st.zone < 5 ? floors[st.zone] - 1 : max;
  if (App.settings.hrAutoAdjust === false) {
    // Ajuste automático desactivado: la velocidad no se toca; solo se avisa si el pulso sale de la zona.
    s.hrState = avg < lo ? 'below' : avg > hi ? 'above' : 'ok';
    if (s.hrState !== 'ok' && now - (s.hrCueAt || 0) > 45000) {
      s.hrCueAt = now;
      Sound.beep(s.hrState === 'above' ? 440 : 880, 0.25);
      Sound.say(s.hrState === 'above' ? 'Pulso alto, baja el ritmo' : 'Pulso bajo, sube el ritmo');
    }
    return;
  }
  let delta = 0;
  if (avg < lo) delta = trend >= HR_CTRL.trendBpm ? 0 : lo - avg > 10 ? HR_CTRL.up * 2 : HR_CTRL.up;
  else if (avg > hi) delta = trend <= -HR_CTRL.trendBpm ? 0 : -(avg - hi > 8 ? HR_CTRL.bigDown : HR_CTRL.down);
  if (!delta) { s.hrState = avg >= lo && avg <= hi ? 'ok' : 'wait'; return; }
  const range = t.speedRange || { min: 1, max: 20 };
  const cap = Math.min(st.maxSpeed > 0 ? st.maxSpeed : st.speed + 2, range.max);
  const floor = Math.max(HR_CTRL.minKmh, range.min);
  const cur = App.targetSpeed || st.speed;
  const next = clamp(cur + delta, floor, Math.max(cap, floor));
  if (Math.abs(next - cur) < 0.05) { s.hrState = delta > 0 ? 'cap' : 'floor'; return; }
  s.hrState = delta > 0 ? 'up' : 'down';
  s.hrAdjAt = now;
  log(`Pulso ${Math.round(avg)} (zona ${st.zone}: ${lo}–${hi}) → ${next.toFixed(2)} km/h`);
  setTarget(next);
}

/**
 * Vigila que la cinta haga lo que se le pide y detecta lo que se hace desde su consola.
 * Seguridad: solo reenvía el arranque si la cinta NUNCA se ha movido desde que la app la arrancó;
 * si se para después de moverse (stop en la consola, llave de seguridad), la sesión se pone en pausa
 * y la app no vuelve a arrancarla por su cuenta.
 */
function watchdog(s) {
  const t = App.treadmill;
  if (!t || !t.connected) return;
  const v = App.live.speed, now = Date.now(), since = now - App.lastCmdAt;
  if (s.paused) {
    // Reanudar solo cuando la cinta se ha parado del todo y vuelve a arrancar (no mientras frena).
    if (s.autoPaused) {
      if (v < 0.3) s.sawStop = true;
      else if (s.sawStop && v > 0.5) {
        s.paused = false; s.autoPaused = false; s.lastTick = performance.now(); s.moved = true;
        log('Cinta reanudada desde la consola'); updateControls();
      }
    }
    return;
  }
  if (App.targetSpeed <= 0 || s.beltPaused) return;
  if (v > 0.5) s.moved = true;
  if (v < 0.3) {
    if (!s.moved) {
      const sinceStart = now - (s.startAt || 0);
      if (sinceStart > 6000 && !s.retried) {
        s.retried = true;
        log('La cinta no ha arrancado; reenviando la orden');
        safe(async () => { await t.start(); await t.setSpeed(App.targetSpeed); });
      } else if (sinceStart > 20000) {
        autoPause(s, 'La cinta no arranca (¿llave de seguridad puesta?): sesión en pausa');
      }
    } else {
      if (!s.stoppedSince) s.stoppedSince = now;
      else if (now - s.stoppedSince > 3000) autoPause(s, 'Cinta parada desde la consola: sesión en pausa');
    }
  } else {
    s.stoppedSince = null;
    if (since > 6000 && Math.abs(v - App.targetSpeed) > 0.25) {
      if (s.divV == null || Math.abs(v - s.divV) > 0.1) { s.divV = v; s.divSince = now; }
      else if (now - s.divSince > 3000) {
        App.targetSpeed = Math.round(v * 10) / 10;
        s.divV = null;
        log(`Velocidad cambiada desde la consola: ${App.targetSpeed} km/h`);
      }
    } else s.divV = null;
  }
}

function tick() {
  const s = App.session;
  if (s) {
    const now = performance.now();
    let dt = (now - s.lastTick) / 1000;
    s.lastTick = now;
    if (dt > 120) dt = 120;
    if (!s.paused && dt > 0) accumulate(s, dt);
    if (App.session === s) {
      watchdog(s);
      hrControl(s);
      if (Date.now() - s.lastSave > 30000) { s.lastSave = Date.now(); Store.set('active', s); }
    }
  }
  updateGrid();
}

function togglePause() {
  const s = App.session, t = App.treadmill;
  if (!s) return;
  if (s.paused) {
    s.paused = false; s.autoPaused = false; s.lastTick = performance.now();
    log('Sesión reanudada');
    if (t && t.connected && !s.beltPaused && App.targetSpeed > 0) startBelt(App.targetSpeed);
  } else {
    s.paused = true; s.autoPaused = false;
    log('Sesión en pausa');
    if (t && t.connected) cmd(() => t.pause());
  }
  Sound.beep(500, 0.2);
  updateControls();
}

/** Para la cinta y guarda la sesión. Devuelve una promesa que termina cuando todo está hecho. */
function finishSession() {
  const s = App.session, t = App.treadmill;
  if (!s) return Promise.resolve();
  App.session = null;
  App.targetSpeed = startTarget(); // la siguiente carrera vuelve a empezar en el ritmo inicial
  const stopped = t && t.connected ? cmd(() => t.stop()) : Promise.resolve();
  releaseWakeLock();
  updateControls();
  renderGrid();
  log(`Sesión terminada: ${fmtTime(s.elapsed)}, ${fmtDist(s.dist)}`);
  if (s.elapsed < 20) { Store.remove('active'); toast('Sesión demasiado corta: no se guarda'); return stopped; }
  s.samples.push([Math.round((Date.now() - s.start) / 1000), Math.round(s.elapsed), Math.round(s.dist), 0, currentHr() || 0, s.steps ? s.stepIdx : 0]);
  const sum = saveSession(s);
  if (!sum) {
    // No se pudo guardar (almacenamiento lleno): se conserva como sesión a recuperar.
    Store.set('active', s);
    return stopped;
  }
  Store.remove('active');
  showSummary(sum);
  return Promise.all([stopped, desktopAfterSave(sum)]);
}

/* ---------- Velocidad ---------- */

let speedTimer = null;
/** Velocidad con la que empieza una carrera libre (ritmo inicial en min/km, 6:00 por defecto). */
function startTarget() {
  return isPace() ? 3600 / (App.settings.freeStartPace || 360) : App.settings.freeStartSpeed;
}
/** Sin sesión, el objetivo muestra (y permite ajustar) el valor con el que se empezará. */
function resetIdleTarget() {
  if (!App.session) { App.targetSpeed = startTarget(); updateGrid(); }
}

/** Fija la velocidad objetivo. En min/km se guardan 3 decimales para que el ritmo quede exacto también a ritmos lentos. */
function setTarget(kmh, decimals = isPace() ? 3 : 1) {
  const t = App.treadmill;
  const r = (t && t.speedRange) || { min: 0.5, max: 20 };
  const f = Math.pow(10, decimals);
  kmh = Math.round(clamp(kmh, r.min, r.max) * f) / f;
  App.targetSpeed = kmh;
  App.lastCmdAt = Date.now();
  const s = App.session;
  if (s) s.beltPaused = false;
  updateGrid();
  clearTimeout(speedTimer);
  speedTimer = setTimeout(() => {
    if (!t || !t.connected) return;
    if (s && s.paused) return;
    if (!s) return; // antes de empezar solo se ajusta el valor de inicio
    if (App.live.speed < 0.3) startBelt(kmh);
    else cmd(() => t.setSpeed(kmh));
  }, 250);
}

/** +/− : dir = +1 más rápido, −1 más despacio. En min/km salta de paceStep en paceStep (p. ej. 5:30 → 5:25). */
function changeTarget(dir) {
  const cur = App.targetSpeed || App.live.speed || startTarget();
  if (!isPace()) return setTarget(cur + dir * App.settings.speedStep);
  const step = Math.max(1, Math.round(App.settings.paceStep || 5));
  const sec = Math.round(3600 / Math.max(cur, 0.5));
  const next = dir > 0 ? Math.floor((sec - 1) / step) * step : Math.ceil((sec + 1) / step) * step;
  setTarget(3600 / Math.max(next, 60));
}

function renderPresets() {
  const box = $('#presets');
  if (!box) return;
  box.innerHTML = '';
  if (isPace()) {
    (App.settings.pacePresets || []).forEach(sec => box.append(h('button', { class: 'btn preset', title: `${(3600 / sec).toFixed(1)} km/h`, onclick: () => setTarget(3600 / sec) }, fmtTime(sec).replace(/^0/, ''))));
  } else {
    App.settings.presets.forEach(p => box.append(h('button', { class: 'btn preset', title: `${fmtPace(p)} /km`, onclick: () => setTarget(p) }, p)));
  }
}

/** Cambia las unidades de toda la app. */
function setUnits(unit) {
  App.settings.workoutUnit = unit === 'pace' ? 'pace' : 'speed';
  Store.set('settings', App.settings);
  resetIdleTarget();
  renderPresets();
  renderGrid();
  if ($('#view-workouts').classList.contains('active')) renderEditor();
  if ($('#view-settings').classList.contains('active')) renderSettings();
}

/* ---------- Interfaz ---------- */

function updateControls() {
  const s = App.session;
  $('#btnStart').hidden = !!s;
  $('#btnStart').disabled = !!App.starting;
  $('#btnPause').hidden = !s;
  $('#btnStop').hidden = !s;
  $('#btnPause').textContent = s && s.paused ? '▶ Reanudar' : '⏸ Pausa';
  $('#btnPause').classList.toggle('primary', !!(s && s.paused));
  $('#selWorkout').disabled = !!s;
  const hasSteps = !!(s && s.steps);
  $('#btnPrevStep').hidden = !hasSteps;
  $('#btnNextStep').hidden = !hasSteps;
  document.body.classList.toggle('running', !!s && !s.paused);
  document.body.classList.toggle('paused', !!(s && s.paused));
}

function switchView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'workouts') renderWorkoutsView();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'train') renderGrid();
}

function onWorkoutSelected() {
  Store.set('lastWorkout', $('#selWorkout').value);
  updateGrid(true);
}

async function requestWakeLock() {
  if (Desktop) Desktop.power.keepAwake(true).catch(() => { });
  try { if (navigator.wakeLock) App.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { }
}
function releaseWakeLock() {
  if (Desktop) Desktop.power.keepAwake(false).catch(() => { });
  try { if (App.wakeLock) App.wakeLock.release(); } catch (e) { }
  App.wakeLock = null;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => { });
}

function recoverActiveSession() {
  const a = Store.get('active', null);
  if (!a) return;
  Store.remove('active');
  if (!a.samples || a.elapsed < 20) return;
  if (confirm(`Hay una sesión que no se terminó correctamente (${a.name}, ${fmtTime(a.elapsed)}, ${fmtDist(a.dist)}). ¿Guardarla en el historial?`)) {
    const sum = saveSession(a);
    if (sum) desktopAfterSave(sum);
    toast('Sesión recuperada y guardada en el historial');
  }
}

function init() {
  App.targetSpeed = startTarget();
  applyLayoutStyles();
  refreshWorkoutSelect();
  renderPresets();
  setupLayoutEditor();
  renderGrid();
  updateControls();
  updateChips();

  setupDesktop();
  if (!navigator.bluetooth) $('#bleWarning').hidden = false;

  $$('.tabs button').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('#btnTreadmill').onclick = onTreadmillChip;
  $('#btnHr').onclick = onHrChip;
  $('#btnConnBle').onclick = connectBle;
  $('#btnConnSim').onclick = connectSim;
  $('#btnStart').onclick = startSession;
  $('#btnPause').onclick = togglePause;
  $('#btnStop').onclick = finishSession;
  $('#btnSlower').onclick = () => changeTarget(-1);
  $('#btnFaster').onclick = () => changeTarget(1);
  $('#btnPrevStep').onclick = () => App.session && gotoStep(App.session.stepIdx - 1);
  $('#btnNextStep').onclick = () => {
    const s = App.session;
    if (!s || !s.steps) return;
    if (s.stepIdx >= s.steps.length - 1 && !confirm('Es el último paso: saltarlo termina el entrenamiento. ¿Terminar?')) return;
    gotoStep(s.stepIdx + 1);
  };
  $('#btnEditLayout').onclick = () => toggleEditing(!App.editing);
  $('#btnDoneLayout').onclick = () => toggleEditing(false);
  $('#btnFullscreen').onclick = toggleFullscreen;
  $('#selWorkout').onchange = onWorkoutSelected;
  $$('dialog [data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

  document.addEventListener('keydown', e => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('dialog[open]')) return;
    if (!$('#view-train').classList.contains('active')) return;
    // Un botón con el foco se pulsaría también con Espacio (p. ej. una velocidad rápida): se le quita.
    if (['Space', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.code) && document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    if (e.code === 'Space') { e.preventDefault(); if (App.session) togglePause(); }
    else if (e.code === 'Escape') { if (App.session && !App.session.paused) togglePause(); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); $('#btnFaster').click(); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); $('#btnSlower').click(); }
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && App.session) requestWakeLock(); });
  // Con una sesión en marcha se pide confirmación al cerrar (en escritorio la muestra el proceso
  // principal y, si se acepta, llama a __closeSafely: para la cinta, guarda y cierra).
  window.addEventListener('beforeunload', e => {
    if (!App.session || App.closing) return;
    Store.set('active', App.session);
    e.preventDefault(); e.returnValue = '';
  });
  window.__closeSafely = async () => {
    try { await Promise.race([finishSession(), sleep(4000)]); } catch (e) { }
    App.closing = true;
    window.close();
  };
  let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => updateGrid(true), 150); });

  setInterval(tick, 500);
  log('CintaPC iniciada' + (navigator.bluetooth ? '' : ' (sin Web Bluetooth en este navegador)'));
  recoverActiveSession();
}

document.addEventListener('DOMContentLoaded', init);
