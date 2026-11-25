// Cliente de la API de Strava: OAuth (intercambio y renovación de tokens), subida de .FIT con
// seguimiento del procesamiento, búsqueda de actividades por hora y edición de nombre/descripción.

export class StravaAuthError extends Error {}
export class StravaRetryableError extends Error {
  constructor(message, retryAfterMs) {
    super(message)
    this.retryAfterMs = retryAfterMs
  }
}

export const REQUIRED_SCOPES = ['activity:write', 'activity:read_all']
const REFRESH_MARGIN_S = 120
/** Tipos de Strava en los que puede acabar una carrera en cinta (subida directa o llegada desde Garmin). */
const RUN_TYPES = ['Run', 'VirtualRun', 'TrailRun', 'Walk']

export class StravaClient {
  /** @param {{clientId:string, clientSecret:string, tokens: import('./tokenStore.mjs').TokenStore, baseUrl?:string, fetch?: typeof fetch, now?: () => number}} options */
  constructor(options) {
    this.options = options
    this.baseUrl = (options.baseUrl ?? 'https://www.strava.com').replace(/\/$/, '')
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
    this.refreshing = null
  }

  authorizeUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: ['read', ...REQUIRED_SCOPES].join(','),
      state
    })
    return `${this.baseUrl}/oauth/authorize?${params}`
  }

  async exchangeCode(code, grantedScope) {
    const scope = grantedScope.split(/[,\s]+/).filter(Boolean)
    const missing = REQUIRED_SCOPES.filter((s) => !scope.includes(s))
    if (missing.length > 0) {
      throw new StravaAuthError(`Hay que dar permiso para ${missing.join(' y ')} (no desmarques las casillas al autorizar).`)
    }
    const data = await this.tokenRequest({ code, grant_type: 'authorization_code' })
    const tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      scope,
      athlete: data.athlete ? { id: data.athlete.id, name: [data.athlete.firstname, data.athlete.lastname].filter(Boolean).join(' ') } : null
    }
    await this.options.tokens.save(tokens)
    return tokens
  }

  connection() { return this.options.tokens.load() }

  async disconnect() {
    const tokens = await this.options.tokens.load()
    await this.options.tokens.clear()
    if (tokens) {
      await this.fetch(`${this.baseUrl}/oauth/deauthorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: tokens.accessToken }),
        signal: AbortSignal.timeout(15_000)
      }).catch(() => undefined)
    }
  }

  /** Sube un .FIT (marcado como "trainer": en carrera es cinta). Devuelve el id de la subida. */
  async upload(file, params) {
    const form = new FormData()
    form.append('file', new Blob([file], { type: 'application/octet-stream' }), params.externalId)
    form.append('data_type', 'fit')
    form.append('name', params.name)
    form.append('description', params.description)
    form.append('trainer', '1')
    form.append('external_id', params.externalId)
    const data = await this.api('POST', '/api/v3/uploads', form)
    const id = data.id_str ?? (data.id !== undefined ? String(data.id) : null)
    if (!id) throw new Error('Strava no devolvió el identificador de la subida')
    return id
  }

  async uploadStatus(uploadId) {
    const data = await this.api('GET', `/api/v3/uploads/${encodeURIComponent(uploadId)}`)
    if (data.activity_id) return { kind: 'ready', activityId: data.activity_id }
    if (data.error) {
      if (/duplicate/i.test(data.error)) {
        const id = /duplicate(?:\s+of)?\s+activity\s+(\d+)/i.exec(data.error)?.[1]
        return { kind: 'duplicate', activityId: id ? Number(id) : null }
      }
      return { kind: 'error', message: data.error }
    }
    return { kind: 'processing' }
  }

  /** Carrera del usuario que empezó a esa hora (±tolerancia), o null. */
  async findActivityNear(startedAtMs, toleranceS = 120) {
    const start = Math.floor(startedAtMs / 1000)
    const query = new URLSearchParams({ after: String(start - toleranceS), before: String(start + toleranceS), per_page: '10' })
    const list = await this.api('GET', `/api/v3/athlete/activities?${query}`)
    const distance = (a) => Math.abs(Date.parse(a.start_date) / 1000 - start)
    const matches = (Array.isArray(list) ? list : [])
      .filter((a) => RUN_TYPES.includes(a.sport_type ?? a.type ?? '') && distance(a) <= toleranceS)
      .sort((a, b) => distance(a) - distance(b))
    if (matches[1] && distance(matches[0]) === distance(matches[1])) return null
    return matches[0]?.id ?? null
  }

  async updateActivity(id, changes) {
    await this.api('PUT', `/api/v3/activities/${id}`, JSON.stringify(changes), { 'Content-Type': 'application/json' })
  }

  activityUrl(id) { return `https://www.strava.com/activities/${id}` }

  async tokenRequest(params) {
    const response = await this.send(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, ...params })
    })
    if (response.status === 400 || response.status === 401) {
      throw new StravaAuthError('Strava rechazó la autorización: vuelve a conectar la cuenta.')
    }
    await this.checkRetryable(response)
    if (!response.ok) throw new Error(`Strava respondió ${response.status} al pedir el token`)
    const data = await this.readJson(response)
    if (!data || typeof data.access_token !== 'string' || !data.access_token ||
      typeof data.refresh_token !== 'string' || !data.refresh_token ||
      typeof data.expires_at !== 'number' || !Number.isFinite(data.expires_at) || data.expires_at <= 0) {
      throw new StravaRetryableError('Strava no devolvió tokens válidos; vuelve a intentarlo.')
    }
    return data
  }

  async accessToken(forceRefresh = false) {
    const tokens = await this.options.tokens.load()
    if (!tokens) throw new StravaAuthError('Strava no está conectado.')
    if (!forceRefresh && tokens.expiresAt - REFRESH_MARGIN_S > this.now() / 1000) return tokens.accessToken
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken })
          if ((await this.options.tokens.load()) !== tokens) throw new StravaAuthError('La sesión de Strava ha cambiado: vuelve a conectar la cuenta.')
          const refreshed = { ...tokens, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_at }
          await this.options.tokens.save(refreshed)
          return refreshed.accessToken
        } catch (error) {
          if (error instanceof StravaAuthError && (await this.options.tokens.load()) === tokens) await this.options.tokens.clear()
          throw error
        } finally {
          this.refreshing = null
        }
      })()
    }
    return this.refreshing
  }

  async api(method, path, body, headers = {}) {
    for (const forceRefresh of [false, true]) {
      const token = await this.accessToken(forceRefresh)
      const response = await this.send(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        ...(body !== undefined ? { body } : {})
      })
      if (response.status === 401 && !forceRefresh) continue
      if (response.status === 401 || response.status === 403) {
        const detail = await this.errorDetail(response)
        throw new StravaAuthError(
          `Strava rechazó la petición (${response.status}${detail ? `: ${detail}` : ''}). Vuelve a conectar la cuenta y deja marcados todos los permisos.`
        )
      }
      await this.checkRetryable(response)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Strava respondió ${response.status}: ${text.slice(0, 200)}`)
      }
      return this.readJson(response)
    }
    throw new StravaAuthError('Strava no está conectado.')
  }

  async send(url, init) {
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      throw new StravaRetryableError(`Sin conexión con Strava (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  async errorDetail(response) {
    const text = await response.text().catch(() => '')
    try {
      const body = JSON.parse(text)
      const errors = Array.isArray(body.errors) ? body.errors.map((e) => [e.field, e.code].filter((v) => typeof v === 'string' && v).join(' ')) : []
      return [typeof body.message === 'string' ? body.message : '', ...errors].filter(Boolean).join('; ').slice(0, 200)
    } catch {
      return text.slice(0, 200)
    }
  }

  async readJson(response) {
    try {
      return await response.json()
    } catch {
      throw new StravaRetryableError('La respuesta de Strava llegó incompleta; se reintentará.')
    }
  }

  async checkRetryable(response) {
    if (response.status === 429) {
      const after = Number(response.headers.get('retry-after'))
      throw new StravaRetryableError('Límite de peticiones de Strava: se reintentará', Number.isFinite(after) && after > 0 ? after * 1000 : 15 * 60_000)
    }
    if (response.status >= 500) throw new StravaRetryableError(`Strava no está disponible ahora (${response.status})`)
  }
}
