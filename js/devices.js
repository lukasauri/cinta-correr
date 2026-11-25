'use strict';
/* Dispositivos: cinta FTMS por Bluetooth, simulador y pulsómetro BLE */

class Emitter {
  constructor() { this._handlers = {}; }
  on(e, f) { (this._handlers[e] || (this._handlers[e] = [])).push(f); }
  emit(e, ...a) { (this._handlers[e] || []).forEach(f => { try { f(...a); } catch (err) { console.error(err); } }); }
}

const FTMS = {
  SERVICE: 0x1826,
  FEATURE: 0x2acc,
  TREADMILL_DATA: 0x2acd,
  SPEED_RANGE: 0x2ad4,
  CONTROL_POINT: 0x2ad9,
  STATUS: 0x2ada,
};
// Servicios extra que pedimos solo para el registro de diagnóstico
const EXTRA_SERVICES = [0x180a, 0x180d, 0x1814, 0x1816, 0xfff0, 0xffe0];
const CP_RESULT = { 1: 'OK', 2: 'no soportada', 3: 'parámetro inválido', 4: 'falló', 5: 'control no permitido' };

const toHex = dv => Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)).map(b => b.toString(16).padStart(2, '0')).join(' ');

class TreadmillFTMS extends Emitter {
  constructor(log) {
    super();
    this.log = log;
    this.isSim = false;
    this.device = null;
    this.cp = null;
    this.connected = false;
    this.hasControl = false;
    this.queue = Promise.resolve();
    this._pending = null;
    this.speedRange = { min: 1, max: 12, step: 0.1 };
    this._onDataEvt = e => this._onData(e.target.value);
    this._onCPEvt = e => this._onCP(e.target.value);
    this._onStatusEvt = e => this._onStatus(e.target.value);
  }

  get name() { return (this.device && this.device.name) || 'Cinta'; }

  async connect(showAll) {
    const opts = showAll
      ? { acceptAllDevices: true, optionalServices: [FTMS.SERVICE, ...EXTRA_SERVICES] }
      : { filters: [{ services: [FTMS.SERVICE] }], optionalServices: EXTRA_SERVICES };
    this.device = await navigator.bluetooth.requestDevice(opts);
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    this.log(`Dispositivo seleccionado: ${this.device.name || '(sin nombre)'}`);
    await this._setup();
  }

  async reconnect() {
    if (!this.device) throw new Error('No hay dispositivo');
    await this._setup();
  }

  async _setup() {
    const server = await this.device.gatt.connect();
    try {
      const svcs = await server.getPrimaryServices();
      this.log('Servicios encontrados: ' + svcs.map(s => s.uuid.slice(4, 8)).join(', '));
    } catch (e) { }

    let svc;
    try { svc = await server.getPrimaryService(FTMS.SERVICE); }
    catch (e) {
      this.device.gatt.disconnect();
      throw new Error('Este dispositivo no ofrece el servicio FTMS. Mira el registro en Ajustes > Diagnóstico.');
    }

    try {
      const dv = await (await svc.getCharacteristic(FTMS.SPEED_RANGE)).readValue();
      const min = dv.getUint16(0, true) / 100, max = dv.getUint16(2, true) / 100, step = dv.getUint16(4, true) / 100;
      if (max > min) this.speedRange = { min, max, step: step || 0.1 };
      this.log(`Rango de velocidad: ${min}–${max} km/h (paso ${step})`);
    } catch (e) { this.log('La cinta no informa del rango de velocidad; se usa 1–12 km/h'); }

    try {
      const dv = await (await svc.getCharacteristic(FTMS.FEATURE)).readValue();
      this.log('Características FTMS: ' + toHex(dv));
    } catch (e) { }

    const data = await svc.getCharacteristic(FTMS.TREADMILL_DATA);
    data.addEventListener('characteristicvaluechanged', this._onDataEvt);
    await data.startNotifications();

    try {
      this.cp = await svc.getCharacteristic(FTMS.CONTROL_POINT);
      this.cp.addEventListener('characteristicvaluechanged', this._onCPEvt);
      await this.cp.startNotifications();
      this.log('Punto de control disponible: la app puede cambiar la velocidad');
    } catch (e) {
      this.cp = null;
      this.log('Sin punto de control (' + e.message + '): solo se leerán datos');
    }

    try {
      const st = await svc.getCharacteristic(FTMS.STATUS);
      st.addEventListener('characteristicvaluechanged', this._onStatusEvt);
      await st.startNotifications();
    } catch (e) { }

    this.connected = true;
    this.hasControl = false;
    this.emit('connected');
  }

  disconnect() {
    this._manual = true;
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    else this._onDisconnected();
  }

  _onDisconnected() {
    if (!this.connected && !this._manual) return;
    this.connected = false;
    this.cp = null;
    this.hasControl = false;
    this.log('Cinta desconectada');
    this.emit('disconnected', !this._manual);
    this._manual = false;
  }

  _onData(dv) {
    try {
      let i = 0;
      const f = dv.getUint16(i, true); i += 2;
      const d = {};
      if (!(f & 0x0001)) { d.speed = dv.getUint16(i, true) / 100; i += 2; }     // velocidad instantánea
      if (f & 0x0002) { d.avgSpeed = dv.getUint16(i, true) / 100; i += 2; }
      if (f & 0x0004) { d.distance = dv.getUint16(i, true) + (dv.getUint8(i + 2) << 16); i += 3; }
      if (f & 0x0008) { d.incline = dv.getInt16(i, true) / 10; i += 4; }      // inclinación + ángulo
      if (f & 0x0010) { i += 4; }                                              // desnivel
      if (f & 0x0020) { i += 1; }                                              // ritmo instantáneo
      if (f & 0x0040) { i += 1; }                                              // ritmo medio
      if (f & 0x0080) { const k = dv.getUint16(i, true); if (k !== 0xffff) d.kcal = k; i += 5; }
      if (f & 0x0100) { const hr = dv.getUint8(i); if (hr) d.hr = hr; i += 1; }
      if (f & 0x0200) { i += 1; }                                              // MET
      if (f & 0x0400) { d.elapsed = dv.getUint16(i, true); i += 2; }
      this.emit('data', d);
    } catch (e) {
      this.log('Paquete de datos no reconocido: ' + toHex(dv));
    }
  }

  _onCP(dv) {
    if (dv.getUint8(0) !== 0x80) return;
    const op = dv.getUint8(1), r = dv.getUint8(2);
    if (r !== 1) this.log(`Orden 0x${op.toString(16)} → ${CP_RESULT[r] || r}`);
    // Solo vale la respuesta a la orden que se está esperando (una tardía no responde a la siguiente).
    if (this._pending && this._pendingOp === op) { const p = this._pending; this._pending = null; p(r); }
  }

  _onStatus(dv) {
    const op = dv.getUint8(0), param = dv.byteLength > 1 ? dv.getUint8(1) : null;
    if (op === 0xff) { this.hasControl = false; this.log('La cinta retiró el permiso de control'); }
    this.emit('status', { op, param });
  }

  /** Escribe en el punto de control y espera la respuesta (en cola, una orden cada vez) */
  _write(bytes) {
    const run = async () => {
      if (!this.cp) throw new Error('La cinta no permite control remoto');
      const resp = new Promise(res => {
        this._pending = res;
        this._pendingOp = bytes[0];
        setTimeout(() => { if (this._pending === res) { this._pending = null; res(null); } }, 2000);
      });
      const buf = new Uint8Array(bytes);
      if (this.cp.writeValueWithResponse) await this.cp.writeValueWithResponse(buf);
      else await this.cp.writeValue(buf);
      return resp;
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => { });
    return p;
  }

  async _cmd(bytes) {
    if (!this.connected) throw new Error('Cinta no conectada');
    if (!this.hasControl) {
      const r = await this._write([0x00]);
      this.hasControl = (r === 1 || r === null);
    }
    let r = await this._write(bytes);
    if (r === 5) { await this._write([0x00]); this.hasControl = true; r = await this._write(bytes); }
    return r;
  }

  setSpeed(kmh) {
    const k = clamp(kmh, this.speedRange.min, this.speedRange.max);
    const v = Math.round(k * 100);
    return this._cmd([0x02, v & 0xff, (v >> 8) & 0xff]);
  }
  start() { return this._cmd([0x07]); }
  /** Pausa; si la cinta no admite pausa (o falla), se para: nunca debe seguir en marcha. */
  async pause() {
    const r = await this._cmd([0x08, 0x02]);
    if (r === 2 || r === 3 || r === 4) { this.log('La cinta no admite pausa: se envía parar'); return this._cmd([0x08, 0x01]); }
    return r;
  }
  stop() { return this._cmd([0x08, 0x01]); }
}

/** Simulador: mismo interfaz que la cinta real, para probar sin hardware */
class TreadmillSim extends Emitter {
  constructor(log) {
    super();
    this.log = log;
    this.isSim = true;
    this.connected = false;
    this.speed = 0; this.target = 0; this.running = false;
    this.dist = 0; this.hr = 70;
    this.speedRange = { min: 1, max: 16, step: 0.1 };
  }
  get name() { return 'Simulador'; }
  async connect() {
    this.connected = true;
    this.timer = setInterval(() => this._step(), 500);
    this.log('Simulador conectado');
    this.emit('connected');
  }
  reconnect() { return this.connect(); }
  disconnect() {
    clearInterval(this.timer);
    this.connected = false;
    this.speed = 0;
    this.emit('disconnected', false);
  }
  _step() {
    const goal = this.running ? this.target : 0;
    this.speed += clamp(goal - this.speed, -0.4, 0.4);
    if (goal === 0 && this.speed < 0.05) this.speed = 0;
    this.dist += this.speed / 3.6 * 0.5;
    this.hr += (62 + this.speed * 10 - this.hr) * 0.03;
    this.emit('data', { speed: Math.round(this.speed * 100) / 100, distance: Math.round(this.dist), hr: Math.round(this.hr + Math.random() * 2) });
  }
  async setSpeed(k) { this.target = clamp(k, this.speedRange.min, this.speedRange.max); this.running = true; return 1; }
  async start() { this.running = true; if (!this.target) this.target = this.speedRange.min; return 1; }
  async pause() { this.running = false; return 1; }
  async stop() { this.running = false; this.target = 0; return 1; }
}

/** Pulsómetro Bluetooth estándar (banda, reloj en modo difusión...) */
class HeartRateMonitor extends Emitter {
  constructor(log) {
    super();
    this.log = log;
    this.device = null;
    this.connected = false;
    this._onHrEvt = e => {
      const v = e.target.value, f = v.getUint8(0);
      this.emit('data', (f & 1) ? v.getUint16(1, true) : v.getUint8(1));
    };
  }
  get name() { return (this.device && this.device.name) || 'Pulsómetro'; }
  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    this.device.addEventListener('gattserverdisconnected', () => {
      if (!this.connected && !this._manual) return;
      this.connected = false;
      this.log('Pulsómetro desconectado');
      this.emit('disconnected', !this._manual);
      this._manual = false;
    });
    await this._setup();
  }
  reconnect() { return this._setup(); }
  async _setup() {
    const srv = await this.device.gatt.connect();
    const svc = await srv.getPrimaryService('heart_rate');
    const ch = await svc.getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', this._onHrEvt);
    await ch.startNotifications();
    this.connected = true;
    this.log(`Pulsómetro conectado: ${this.name}`);
    this.emit('connected');
  }
  disconnect() {
    this._manual = true;
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }
}
