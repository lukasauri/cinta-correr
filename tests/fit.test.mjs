import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Decoder, Stream } from '@garmin/fitsdk'
import { encodeRunFit } from '../electron/fit.mjs'

function decode(bytes) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)))
  assert.ok(decoder.isFIT(), 'es un FIT')
  assert.ok(decoder.checkIntegrity(), 'CRC correcto')
  const { messages, errors } = decoder.read()
  assert.deepEqual(errors, [])
  return messages
}

test('FIT de carrera en cinta con pasos, pausa y pulso', () => {
  const start = Date.UTC(2026, 10, 25, 9, 0, 0)
  const samples = []
  // 0-60 s paso 0 a 8 km/h, pausa de 30 s, 60-120 s paso 1 a 12 km/h
  for (let t = 0; t <= 60; t += 2) samples.push([t, t, Math.round(t * 8 / 3.6), 8, 130, 0])
  for (let t = 62; t <= 120; t += 2) samples.push([t + 30, t, Math.round(60 * 8 / 3.6 + (t - 60) * 12 / 3.6), 12, 160, 1])
  const msgs = decode(encodeRunFit({ id: 'abc123', start, end: start + 150_000, elapsed: 120, dist: 333, kcal: 25, samples }))

  const s = msgs.sessionMesgs[0]
  assert.equal(s.sport, 'running')
  assert.equal(s.subSport, 'treadmill')
  assert.equal(s.totalTimerTime, 120)
  assert.equal(s.totalElapsedTime, 150)
  assert.equal(s.totalDistance, 333)
  assert.equal(s.totalCalories, 25)
  assert.equal(s.maxHeartRate, 160)
  assert.equal(msgs.lapMesgs.length, 2)
  assert.equal(msgs.recordMesgs.length, samples.length)
  const timer = msgs.eventMesgs.filter((e) => e.event === 'timer').map((e) => e.eventType)
  assert.deepEqual(timer, ['start', 'stopAll', 'start', 'stopAll'])
  assert.equal(msgs.activityMesgs[0].numSessions, 1)
  assert.equal(msgs.fileIdMesgs[0].type, 'activity')
  assert.equal(new Date(msgs.sessionMesgs[0].startTime).getTime(), start)
})

test('FIT de una sesión antigua sin índice de paso', () => {
  const start = Date.now() - 3_600_000
  const samples = [[0, 0, 0, 5, 0], [2, 2, 3, 5.4, 0], [4, 4, 6, 5.4, 0]]
  const msgs = decode(encodeRunFit({ id: 'x1y2', start, end: start + 5000, elapsed: 4, dist: 6, kcal: 1, samples }))
  assert.equal(msgs.lapMesgs.length, 1)
  assert.equal(msgs.sessionMesgs[0].avgHeartRate, undefined)
})
