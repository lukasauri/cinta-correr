import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { GarminClient, garminEndpointsAt, ticketFromUrl, ticketFromHtml, interpretUpload } from '../electron/integrations/garminClient.mjs'
import { runGarminJob } from '../electron/integrations/garminJob.mjs'
import { StravaClient } from '../electron/integrations/stravaClient.mjs'
import { UploadQueue } from '../electron/integrations/uploadQueue.mjs'

const memoryTokens = (initial = null) => {
  let v = initial
  return { load: async () => v, save: async (x) => { v = x }, clear: async () => { v = null }, get value() { return v } }
}

async function fakeServer(handler) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://x')
    calls.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body })
    const out = await handler({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body })
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' })
    res.end(typeof out.json === 'string' ? out.json : JSON.stringify(out.json ?? {}))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() }
}

test('tickets de Garmin en URL y HTML', () => {
  assert.deepEqual(ticketFromUrl('https://sso.garmin.com/sso/embed?ticket=ST-123-abc'), { ticket: 'ST-123-abc', serviceUrl: 'https://sso.garmin.com/sso/embed' })
  assert.equal(ticketFromUrl('https://sso.garmin.com/sso/embed?ticket=XX'), null)
  assert.equal(ticketFromHtml('var url = "https:\\/\\/sso.garmin.com\\/sso\\/embed?ticket=ST-9-z";', 'fb').serviceUrl, 'https://sso.garmin.com/sso/embed')
  assert.equal(interpretUpload(409, '').kind, 'duplicate')
  assert.equal(interpretUpload(202, JSON.stringify({ detailedImportResult: { successes: [] } })).kind, 'done')
})

test('Garmin: inicio de sesión, subida, búsqueda, nombre y renovación tras 401', async () => {
  let rejectNext = false
  const startedAt = Date.UTC(2026, 10, 25, 9, 0, 0)
  const srv = await fakeServer(({ method, path, body, headers }) => {
    if (path === '/di-oauth2-service/oauth/token') {
      const form = new URLSearchParams(body.toString())
      if (form.get('grant_type') === 'refresh_token') return { json: { access_token: 'tok2', refresh_token: 'ref2', expires_in: 86400 } }
      if (form.get('service_ticket') !== 'ST-1') return { status: 400 }
      return { json: { access_token: 'tok1', refresh_token: 'ref1', expires_in: 86400, refresh_token_expires_in: 2592000 } }
    }
    if (path === '/userprofile-service/socialProfile') return { json: { fullName: 'Corredor Prueba' } }
    if (path === '/upload-service/upload') {
      if (rejectNext) { rejectNext = false; return { status: 401 } }
      assert.match(headers['content-type'], /multipart\/form-data/)
      assert.ok(body.includes(Buffer.from('FITDATA')))
      return { status: 202, json: { detailedImportResult: { successes: [], failures: [] } } }
    }
    if (path === '/activitylist-service/activities/search/activities') {
      const gmt = new Date(startedAt).toISOString().slice(0, 19).replace('T', ' ')
      return { json: [{ activityId: 987, startTimeGMT: gmt }] }
    }
    if (path === '/activity-service/activity/987' && method === 'PUT') return { status: 204, json: '' }
    return { status: 404 }
  })
  const tokens = memoryTokens()
  const client = new GarminClient({ tokens, endpoints: garminEndpointsAt(srv.base) })
  await client.signIn({ ticket: 'ST-1', serviceUrl: `${srv.base}/sso/embed` })
  assert.equal(tokens.value.displayName, 'Corredor Prueba')
  assert.equal(tokens.value.clientId, 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2')

  rejectNext = true // el token se invalida: debe renovarse y repetir
  const job = { activityId: 'abc', name: 'Intervalos', description: 'desc', activityStartedAt: startedAt }
  const deps = { client, readFit: async () => new Uint8Array(Buffer.from('FITDATA')), recover: async () => false }
  const first = await runGarminJob(job, deps)
  assert.equal(first.kind, 'continue')
  assert.equal(tokens.value.accessToken, 'tok2')
  const second = await runGarminJob({ ...job, ...first.patch }, deps)
  assert.equal(second.kind, 'done')
  assert.equal(second.url, `${srv.base}/modern/activity/987`)
  const put = srv.calls.find((c) => c.method === 'PUT')
  assert.deepEqual(JSON.parse(put.body.toString()), { activityId: 987, activityName: 'Intervalos', description: 'desc' })
  srv.close()
})

test('Strava: subida del FIT y seguimiento del procesamiento', async () => {
  const srv = await fakeServer(({ method, path, body }) => {
    if (path === '/api/v3/uploads' && method === 'POST') {
      const text = body.toString()
      assert.ok(text.includes('name="trainer"') && text.includes('name="data_type"'))
      return { status: 201, json: { id_str: '555' } }
    }
    if (path === '/api/v3/uploads/555') return { json: { activity_id: 42 } }
    return { status: 404 }
  })
  const tokens = memoryTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() / 1000 + 3600, scope: [], athlete: null })
  const client = new StravaClient({ clientId: '1', clientSecret: 's', tokens, baseUrl: srv.base })
  const id = await client.upload(new Uint8Array([1, 2, 3]), { name: 'n', description: 'd', externalId: 'abc.fit' })
  assert.equal(id, '555')
  assert.deepEqual(await client.uploadStatus('555'), { kind: 'ready', activityId: 42 })
  srv.close()
})

test('Cola: Garmin sube, Strava espera a Garmin y si no llega sube directamente', async () => {
  let now = 1_000_000
  const seen = []
  const queue = new UploadQueue({
    now: () => now,
    persist: async () => { },
    handlers: {
      garmin: async () => { seen.push('garmin'); return { kind: 'done', message: 'Subida a Garmin Connect', url: 'g' } },
      stravaCheck: async () => { seen.push('check'); return { kind: 'notFound', message: 'esperando' } },
      strava: async () => { seen.push('strava'); return { kind: 'done', message: 'Subida a Strava' } }
    }
  })
  await queue.enqueue({ activityId: 'a1', name: 'n', description: '', startedAt: now }, { garmin: true, strava: true })
  for (let i = 0; i < 20; i++) { now += 300_000; await queue.tick() }
  assert.deepEqual(seen, ['garmin', 'check', 'check', 'check', 'strava'])
  assert.ok(queue.list().every((j) => j.status === 'done'))
})

test('Cola: sin sesión de Garmin, Strava se sube igualmente', async () => {
  let now = 0
  const queue = new UploadQueue({
    now: () => now,
    persist: async () => { },
    handlers: {
      garmin: async () => ({ kind: 'needsAuth', message: 'Inicia sesión' }),
      stravaCheck: async () => ({ kind: 'notFound', message: '' }),
      strava: async () => ({ kind: 'done', message: 'Subida a Strava' })
    }
  })
  await queue.enqueue({ activityId: 'a2', name: 'n', description: '', startedAt: 0 }, { garmin: true, strava: true })
  await queue.tick(); await queue.tick()
  const byTarget = Object.fromEntries(queue.list().map((j) => [j.target, j.status]))
  assert.deepEqual(byTarget, { garmin: 'needsAuth', strava: 'done' })
})

test('Garmin: zonas de pulso (prefiere las de carrera) y respuestas raras', async () => {
  const { pickHrZones } = await import('../electron/integrations/garminClient.mjs')
  const general = { sport: 'DEFAULT', trainingMethod: 'HR_MAX_BASED', zone1Floor: 95, zone2Floor: 114, zone3Floor: 133, zone4Floor: 152, zone5Floor: 171, maxHeartRateUsed: 190, restingHeartRateUsed: 50 }
  const running = { ...general, sport: 'RUNNING', trainingMethod: 'LACTATE_THRESHOLD', zone1Floor: 120, zone2Floor: 140, zone3Floor: 155, zone4Floor: 165, zone5Floor: 175, lactateThresholdHeartRateUsed: 168 }
  assert.deepEqual(pickHrZones([general, running]), { floors: [120, 140, 155, 165, 175], max: 190, resting: 50, lthr: 168, method: 'LACTATE_THRESHOLD', sport: 'RUNNING' })
  assert.equal(pickHrZones([general]).sport, 'DEFAULT')
  assert.equal(pickHrZones([{ ...general, zone3Floor: null }]), null)
  assert.equal(pickHrZones([{ ...general, zone3Floor: 100 }]), null) // no ascendentes
  assert.equal(pickHrZones(null), null)

  const srv = await fakeServer(({ path }) => {
    if (path === '/biometric-service/heartRateZones') return { json: [general, running] }
    return { status: 404 }
  })
  const client = new GarminClient({ tokens: memoryTokens({ accessToken: 't', refreshToken: 'r', clientId: 'c', expiresAt: Date.now() + 86400000, refreshExpiresAt: null, refreshedAt: Date.now(), displayName: null }), endpoints: garminEndpointsAt(srv.base) })
  assert.deepEqual((await client.heartRateZones()).floors, [120, 140, 155, 165, 175])
  srv.close()
})
