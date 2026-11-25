// Codifica una sesión de CintaPC como FIT de carrera en cinta (sport running / sub_sport treadmill):
// file_id, device_info, eventos de temporizador (con las pausas), un record por muestra, una vuelta por
// cada paso del entrenamiento, la sesión y la actividad. Garmin Connect la muestra como
// "Carrera en cinta" y Strava como carrera en interior.
import { Encoder, Profile, Utils } from '@garmin/fitsdk'

const MANUFACTURER = 'development' // fabricante reservado para software no registrado
const PRODUCT_ID = 1
const SOFTWARE_VERSION = 1

function mesgNum(name) {
  const num = Profile.MesgNum[name]
  if (num === undefined) throw new Error(`El SDK de FIT no tiene el mensaje ${name}`)
  return num
}
const MESG = {
  FILE_ID: mesgNum('FILE_ID'),
  DEVICE_INFO: mesgNum('DEVICE_INFO'),
  EVENT: mesgNum('EVENT'),
  RECORD: mesgNum('RECORD'),
  LAP: mesgNum('LAP'),
  SESSION: mesgNum('SESSION'),
  ACTIVITY: mesgNum('ACTIVITY')
}

const date = (ts) => new Date(ts)
const int = (v) => (v === null || v === undefined || !Number.isFinite(v) ? undefined : Math.round(v))
const localTimestamp = (ts) => Utils.convertDateToDateTime(new Date(ts)) - new Date(ts).getTimezoneOffset() * 60
const clean = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== null))
const timerEvent = (ts, eventType) => ({ timestamp: date(ts), event: 'timer', eventType, eventGroup: 0 })
const sport = { sport: 'running', subSport: 'treadmill' }

/**
 * @param {{start:number, end:number, elapsed:number, dist:number, kcal:number, name?:string,
 *          samples: number[][]}} activity  muestras: [segReloj, segActivos, distM, kmh, ppm, paso]
 */
export function encodeRunFit(activity) {
  const start = activity.start
  const raw = (activity.samples || []).filter((p) => Array.isArray(p) && p.length >= 5)
  const samples = raw.map((p) => ({ ts: start + p[0] * 1000, t: p[1], d: p[2], v: p[3] / 3.6, hr: p[4] || null, step: p[5] ?? 0 }))
  const end = Math.max(activity.end || start, samples.at(-1)?.ts ?? start)
  const encoder = new Encoder()

  encoder.onMesg(MESG.FILE_ID, {
    type: 'activity',
    manufacturer: MANUFACTURER,
    product: PRODUCT_ID,
    serialNumber: Math.floor(start / 1000) % 0xffffffff,
    timeCreated: date(start)
  })
  encoder.onMesg(MESG.DEVICE_INFO, {
    deviceIndex: 'creator',
    manufacturer: MANUFACTURER,
    product: PRODUCT_ID,
    productName: 'CintaPC',
    softwareVersion: SOFTWARE_VERSION,
    timestamp: date(start)
  })
  encoder.onMesg(MESG.EVENT, timerEvent(start, 'start'))

  // Las pausas no se guardan aparte: se deducen de que el reloj avanza más que el tiempo activo.
  let prev = null
  for (const s of samples) {
    if (prev) {
      const gap = (s.ts - prev.ts) / 1000 - (s.t - prev.t)
      if (gap > 3) {
        const resume = s.ts - (s.t - prev.t) * 1000
        encoder.onMesg(MESG.EVENT, timerEvent(prev.ts, 'stopAll'))
        encoder.onMesg(MESG.EVENT, timerEvent(Math.max(prev.ts + 1000, resume), 'start'))
      }
    }
    encoder.onMesg(MESG.RECORD, clean({
      timestamp: date(s.ts),
      distance: s.d,
      enhancedSpeed: s.v,
      heartRate: int(s.hr)
    }))
    prev = s
  }
  encoder.onMesg(MESG.EVENT, timerEvent(end, 'stopAll'))

  // Una vuelta por cada paso del entrenamiento (en carrera libre, una sola).
  const groups = []
  for (const s of samples) {
    const g = groups.at(-1)
    if (g && g.step === s.step) g.items.push(s)
    else groups.push({ step: s.step, items: [s] })
  }
  if (!groups.length) groups.push({ step: 0, items: [{ ts: start, t: 0, d: 0, v: 0, hr: null }] })
  let lapStart = { ts: start, t: 0, d: 0 }
  groups.forEach((g, index) => {
    const last = g.items.at(-1)
    const isLast = index === groups.length - 1
    const lapEnd = isLast ? { ts: end, t: activity.elapsed ?? last.t, d: activity.dist ?? last.d } : last
    const hrs = g.items.map((s) => s.hr).filter(Boolean)
    const timer = Math.max(0, lapEnd.t - lapStart.t)
    const dist = Math.max(0, lapEnd.d - lapStart.d)
    encoder.onMesg(MESG.LAP, clean({
      messageIndex: index,
      timestamp: date(lapEnd.ts),
      startTime: date(lapStart.ts),
      totalElapsedTime: (lapEnd.ts - lapStart.ts) / 1000,
      totalTimerTime: timer,
      totalDistance: dist,
      enhancedAvgSpeed: timer > 0 ? dist / timer : 0,
      enhancedMaxSpeed: Math.max(0, ...g.items.map((s) => s.v)),
      avgHeartRate: hrs.length ? int(hrs.reduce((a, b) => a + b, 0) / hrs.length) : undefined,
      maxHeartRate: hrs.length ? Math.max(...hrs) : undefined,
      event: 'lap',
      eventType: 'stop',
      lapTrigger: isLast ? 'sessionEnd' : 'manual',
      ...sport
    }))
    lapStart = lapEnd
  })

  const allHr = samples.map((s) => s.hr).filter(Boolean)
  const timerTotal = activity.elapsed ?? samples.at(-1)?.t ?? 0
  const distTotal = activity.dist ?? samples.at(-1)?.d ?? 0
  encoder.onMesg(MESG.SESSION, clean({
    messageIndex: 0,
    timestamp: date(end),
    startTime: date(start),
    totalElapsedTime: (end - start) / 1000,
    totalTimerTime: timerTotal,
    totalDistance: distTotal,
    totalCalories: int(activity.kcal),
    avgHeartRate: allHr.length ? int(allHr.reduce((a, b) => a + b, 0) / allHr.length) : undefined,
    maxHeartRate: allHr.length ? Math.max(...allHr) : undefined,
    enhancedAvgSpeed: timerTotal > 0 ? distTotal / timerTotal : 0,
    enhancedMaxSpeed: Math.max(0, ...samples.map((s) => s.v)),
    firstLapIndex: 0,
    numLaps: groups.length,
    event: 'session',
    eventType: 'stop',
    trigger: 'activityEnd',
    ...sport
  }))
  encoder.onMesg(MESG.ACTIVITY, {
    timestamp: date(end),
    totalTimerTime: timerTotal,
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
    localTimestamp: localTimestamp(end)
  })
  return encoder.close()
}
