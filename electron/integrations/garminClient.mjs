// NO OFICIAL (mismo método que Rodillo Virtual). Garmin no ofrece API pública para subir actividades
// (exige ser socio), así que este cliente usa el mismo inicio de sesión que la app móvil de Garmin
// Connect: el ticket del inicio de sesión se cambia por tokens "DI" (OAuth2) y la subida va a su API con
// ellos. El token de acceso dura un día y el de renovación varias semanas, pero cada renovación da uno
// nuevo: mientras la app se use de vez en cuando no hay que volver a iniciar sesión.
// Si Garmin cambia este acceso, habrá que adaptarlo.

export const GARMIN_ENDPOINTS = {
  sso: 'https://sso.garmin.com',
  diauth: 'https://diauth.garmin.com',
  connectapi: 'https://connectapi.garmin.com',
  connect: 'https://connect.garmin.com'
}

/** Todas las direcciones en un mismo servidor (para pruebas con un Garmin falso). */
export function garminEndpointsAt(baseUrl) {
  const base = baseUrl.replace(/\/$/, '')
  return { sso: base, diauth: base, connectapi: base, connect: base }
}

/** No hay sesión o ya no vale: hay que volver a iniciarla. */
export class GarminAuthError extends Error {}
/** Fallo pasajero (sin conexión, Garmin caído o limitando peticiones): se reintenta más tarde. */
export class GarminRetryableError extends Error {}

const DI_CLIENT_IDS = [
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI'
]
const DI_GRANT_SERVICE_TICKET = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket'
const NATIVE_HEADERS = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861',
  'X-Garmin-Client-Platform': 'Android',
  'X-App-Ver': '10861',
  'X-Lang': 'en',
  'X-GCExperience': 'GC5',
  'Accept-Language': 'en-US,en;q=0.9'
}

const REFRESH_MARGIN_MS = 15 * 60_000
const DEFAULT_ACCESS_LIFETIME_MS = 3600_000
const REQUEST_TIMEOUT_MS = 30_000
const DAY_MS = 24 * 3600_000
/** Diferencia admitida entre la hora de inicio de la app y la de Garmin (el FIT va en segundos). */
const START_MATCH_MS = 2000
const UPLOAD_TIMEOUT_MS = 120_000

/** Página de inicio de sesión de Garmin (el widget "embed"). Al terminar entrega un ticket de un solo uso. */
export function garminSignInUrl(sso) {
  const embed = `${sso}/sso/embed`
  const params = new URLSearchParams({
    id: 'gauth-widget',
    embedWidget: 'true',
    gauthHost: embed,
    service: embed,
    source: embed,
    redirectAfterAccountLoginUrl: embed,
    redirectAfterAccountCreationUrl: embed
  })
  return { url: `${sso}/sso/signin?${params}`, serviceUrl: embed }
}

/** Ticket en una dirección a la que se navega (`…?ticket=ST-…`). */
export function ticketFromUrl(url) {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  const ticket = parsed.searchParams.get('ticket')
  if (!ticket?.startsWith('ST-')) return null
  parsed.searchParams.delete('ticket')
  parsed.hash = ''
  return { ticket, serviceUrl: parsed.toString() }
}

/** Ticket en el HTML de la página "Success" (ahí la dirección va en una variable de JavaScript). */
export function ticketFromHtml(html, fallbackServiceUrl) {
  const match = /(https?:(?:\\?\/){2}[^\s"'?<>]+)?\?ticket=(ST-[A-Za-z0-9._-]+)/.exec(html)
  if (!match) return null
  return { ticket: match[2], serviceUrl: match[1] ? match[1].replace(/\\\//g, '/') : fallbackServiceUrl }
}

function decodeJwtPayload(token) {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/** Tokens a partir de la respuesta de Garmin; null si no trae lo necesario. */
function parseTokenResponse(body, clientId, now, previous) {
  if (!body || typeof body !== 'object') return null
  const accessToken = body.access_token
  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previous?.refreshToken
  if (typeof accessToken !== 'string' || !accessToken || !refreshToken) return null
  const payload = decodeJwtPayload(accessToken)
  const seconds = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * 1000 : null)
  const expiresIn = seconds(body.expires_in)
  const jwtExp = seconds(payload?.exp)
  const refreshIn = seconds(body.refresh_token_expires_in)
  return {
    accessToken,
    refreshToken,
    // La renovación tiene que ir con el cliente que dice el propio token, si lo dice.
    clientId: typeof payload?.client_id === 'string' && payload.client_id ? payload.client_id : clientId,
    expiresAt: expiresIn !== null ? now + expiresIn : jwtExp ?? now + DEFAULT_ACCESS_LIFETIME_MS,
    refreshExpiresAt: refreshIn !== null ? now + refreshIn : refreshToken === previous?.refreshToken ? previous.refreshExpiresAt : null,
    refreshedAt: now,
    displayName: previous?.displayName ?? null
  }
}

/** Interpreta la respuesta del servicio de subida de Garmin. */
export function interpretUpload(status, body) {
  let json = {}
  try {
    const parsed = JSON.parse(body)
    if (parsed && typeof parsed === 'object') json = parsed
  } catch { /* sin cuerpo JSON */ }
  const detailed = json.detailedImportResult
  const result = detailed && typeof detailed === 'object' ? detailed : json
  const success = Array.isArray(result.successes) ? result.successes[0] : undefined
  const failure = Array.isArray(result.failures) ? result.failures[0] : undefined
  const failureText = Array.isArray(failure?.messages) ? failure.messages.map((m) => m.content).join(' ') : ''
  const id = (v) => (v !== undefined && v !== null ? String(v) : null)
  if (status === 409 || /duplicate/i.test(failureText)) return { kind: 'duplicate', activityId: id(failure?.internalId) }
  if (status === 401) return { kind: 'needsLogin' }
  if (status >= 200 && status < 300 && success && !failure) return { kind: 'done', activityId: id(success.internalId) }
  // 202: aceptada y en proceso; Garmin todavía no sabe el id de la actividad.
  if ((status === 201 || status === 202) && detailed && typeof detailed === 'object' && !failure) return { kind: 'done', activityId: null }
  if (status === 403) {
    return { kind: 'error', message: 'Garmin rechazó la subida (403). Puede ser un bloqueo pasajero de Garmin: se reintentará.', retryable: true }
  }
  return {
    kind: 'error',
    message: failureText || `Garmin no confirmó la importación (respuesta ${status})`,
    retryable: status >= 500 || status === 0 || status === 429
  }
}

const ZONE_KEYS = ['zone1Floor', 'zone2Floor', 'zone3Floor', 'zone4Floor', 'zone5Floor']

/**
 * Zonas de pulso de la respuesta de Garmin (una configuración por deporte). Se prefieren las de carrera;
 * si no las hay, las generales (DEFAULT). null si la respuesta no trae zonas válidas.
 */
export function pickHrZones(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.zones) ? body.zones : body && typeof body === 'object' ? [body] : []
  const valid = list.filter((z) => z && ZONE_KEYS.every((k) => Number.isFinite(z[k]) && z[k] > 0) &&
    ZONE_KEYS.every((k, i) => i === 0 || z[k] > z[ZONE_KEYS[i - 1]]))
  const sport = (z) => String(z.sport ?? 'DEFAULT').toUpperCase()
  const zone = valid.find((z) => sport(z) === 'RUNNING') ?? valid.find((z) => sport(z) === 'DEFAULT') ?? valid[0]
  if (!zone) return null
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null)
  return {
    floors: ZONE_KEYS.map((k) => Math.round(zone[k])),
    max: num(zone.maxHeartRateUsed),
    resting: num(zone.restingHeartRateUsed),
    lthr: num(zone.lactateThresholdHeartRateUsed),
    method: typeof zone.trainingMethod === 'string' ? zone.trainingMethod : null,
    sport: sport(zone)
  }
}

function multipart(file, fileName) {
  const boundary = `----CintaPC${crypto.randomUUID().replace(/-/g, '')}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName.replace(/["\r\n]/g, '_')}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, Buffer.from(file), tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

const errorText = (e) => (e instanceof Error ? e.message : String(e))

/** Sesión de Garmin Connect con tokens renovables y subida de .FIT a su API. */
export class GarminClient {
  /** @param {{tokens: import('./tokenStore.mjs').TokenStore, endpoints?: typeof GARMIN_ENDPOINTS, fetch?: typeof fetch, now?: () => number}} options */
  constructor(options) {
    this.options = options
    this.endpoints = options.endpoints ?? GARMIN_ENDPOINTS
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
    this.refreshing = null
  }

  get importPageUrl() { return `${this.endpoints.connect}/modern/import-data` }
  activityUrl(id) { return `${this.endpoints.connect}/modern/activity/${id}` }

  /** La sesión guardada, si todavía se puede renovar. */
  async connection() {
    const tokens = await this.options.tokens.load()
    if (!tokens || (tokens.refreshExpiresAt !== null && tokens.refreshExpiresAt <= this.now())) return null
    return { displayName: tokens.displayName }
  }

  /** Cambia el ticket del inicio de sesión (vale una vez y poco tiempo) por tokens y los guarda. */
  async signIn({ ticket, serviceUrl }) {
    let lastStatus = 0
    for (const clientId of DI_CLIENT_IDS) {
      const response = await this.tokenRequest(clientId, {
        client_id: clientId,
        service_ticket: ticket,
        grant_type: DI_GRANT_SERVICE_TICKET,
        service_url: serviceUrl
      })
      if (response.status === 429) throw new GarminRetryableError('Garmin está limitando los inicios de sesión: espera unos minutos y vuelve a intentarlo.')
      if (response.status >= 500) throw new GarminRetryableError(`Garmin Connect no está disponible ahora (${response.status}). Vuelve a intentarlo más tarde.`)
      if (!response.ok) { lastStatus = response.status; continue }
      const tokens = parseTokenResponse(await response.json().catch(() => null), clientId, this.now(), null)
      if (!tokens) continue
      tokens.displayName = await this.profileName(tokens.accessToken)
      await this.options.tokens.save(tokens)
      return
    }
    throw new GarminAuthError(`Garmin no aceptó el inicio de sesión${lastStatus ? ` (respuesta ${lastStatus})` : ''}. Vuelve a intentarlo.`)
  }

  /** Renueva la sesión (Garmin da un token de renovación nuevo cada vez). Solo una renovación a la vez. */
  refresh() {
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  /** Renueva si hace más de `maxAgeMs` de la última vez, para que el token de renovación no caduque. */
  async keepAlive(maxAgeMs) {
    const tokens = await this.options.tokens.load()
    if (tokens && this.now() - tokens.refreshedAt >= maxAgeMs) await this.refresh()
  }

  async upload(file, fileName) {
    const { body, contentType } = multipart(file, fileName)
    try {
      const response = await this.api('/upload-service/upload', { method: 'POST', headers: { 'Content-Type': contentType }, body }, UPLOAD_TIMEOUT_MS)
      return interpretUpload(response.status, await response.text().catch(() => ''))
    } catch (error) {
      if (error instanceof GarminAuthError) return { kind: 'needsLogin' }
      return { kind: 'error', message: errorText(error), retryable: true }
    }
  }

  /** Id de la actividad que empieza a esa hora, o null si todavía no aparece (Garmin tarda en procesarla). */
  async findActivity(startedAt) {
    const day = (ms) => new Date(ms).toISOString().slice(0, 10)
    const params = new URLSearchParams({ start: '0', limit: '20', startDate: day(startedAt - DAY_MS), endDate: day(startedAt + DAY_MS) })
    const response = await this.api(`/activitylist-service/activities/search/activities?${params}`)
    if (!response.ok) throw new GarminRetryableError(`Garmin no devolvió las actividades (${response.status}).`)
    const list = await response.json().catch(() => null)
    if (!Array.isArray(list)) return null
    for (const item of list) {
      if (typeof item.startTimeGMT !== 'string' || (typeof item.activityId !== 'number' && typeof item.activityId !== 'string')) continue
      const start = Date.parse(`${item.startTimeGMT.replace(' ', 'T')}Z`)
      if (Math.abs(start - startedAt) <= START_MATCH_MS) return String(item.activityId)
    }
    return null
  }

  /** Pone a la actividad el nombre (y la descripción) de la app. */
  async describeActivity(id, details) {
    const body = { activityId: Number(id), activityName: details.name }
    if (details.description.trim()) body.description = details.description
    const response = await this.api(`/activity-service/activity/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`Garmin no aceptó el nombre de la actividad (${response.status}).`)
  }

  /** Zonas de pulso configuradas en Garmin Connect (las de carrera si las hay). */
  async heartRateZones() {
    const response = await this.api('/biometric-service/heartRateZones')
    if (!response.ok) throw new Error(`Garmin no devolvió las zonas de pulso (${response.status}).`)
    const body = await response.json().catch(() => null)
    const zones = pickHrZones(body)
    if (!zones) throw new Error('Garmin no devolvió zonas de pulso válidas. ¿Tienes zonas configuradas en Garmin Connect?')
    return zones
  }

  async disconnect() { await this.options.tokens.clear() }

  async accessToken() {
    const tokens = await this.options.tokens.load()
    if (!tokens) throw new GarminAuthError('No has iniciado sesión en Garmin Connect.')
    if (tokens.expiresAt - this.now() > REFRESH_MARGIN_MS) return tokens.accessToken
    return (await this.refresh()).accessToken
  }

  async doRefresh() {
    const tokens = await this.options.tokens.load()
    if (!tokens) throw new GarminAuthError('No has iniciado sesión en Garmin Connect.')
    const response = await this.tokenRequest(tokens.clientId, {
      grant_type: 'refresh_token',
      client_id: tokens.clientId,
      refresh_token: tokens.refreshToken
    })
    if (response.status === 400 || response.status === 401) {
      await this.options.tokens.clear()
      throw new GarminAuthError('La sesión de Garmin Connect ha caducado.')
    }
    if (!response.ok) throw new GarminRetryableError(`Garmin no pudo renovar la sesión ahora (${response.status}); se reintentará.`)
    const next = parseTokenResponse(await response.json().catch(() => null), tokens.clientId, this.now(), tokens)
    if (!next) throw new GarminRetryableError('Garmin devolvió una renovación incompleta; se reintentará.')
    await this.options.tokens.save(next)
    return next
  }

  async profileName(accessToken) {
    let response
    try {
      response = await this.send(`${this.endpoints.connectapi}/userprofile-service/socialProfile`, {
        headers: { ...NATIVE_HEADERS, Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
      })
    } catch {
      return null
    }
    if (response.status === 401) throw new GarminAuthError('Garmin rechazó la sesión recién iniciada. Vuelve a intentarlo.')
    const profile = await response.json().catch(() => null)
    const name = [profile?.fullName, profile?.displayName, profile?.userName].find((v) => typeof v === 'string' && v.trim())
    return typeof name === 'string' ? name.trim() : null
  }

  tokenRequest(clientId, form) {
    return this.send(`${this.endpoints.diauth}/di-oauth2-service/oauth/token`, {
      method: 'POST',
      headers: {
        ...NATIVE_HEADERS,
        Authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache'
      },
      body: new URLSearchParams(form).toString()
    })
  }

  /** Petición a la API con el token. Si Garmin lo rechaza, se renueva una vez y se repite. */
  async api(path, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const request = (token) =>
      this.send(
        `${this.endpoints.connectapi}${path}`,
        { ...init, headers: { ...NATIVE_HEADERS, Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers || {}) } },
        timeoutMs
      )
    let response = await request(await this.accessToken())
    if (response.status === 401) response = await request((await this.refresh()).accessToken)
    if (response.status === 401) throw new GarminAuthError('Garmin rechazó la sesión: vuelve a iniciarla.')
    return response
  }

  async send(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
    try {
      return await this.fetch(url, { ...init, credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new GarminRetryableError(`Sin conexión con Garmin Connect (${errorText(error)})`)
    }
  }
}
