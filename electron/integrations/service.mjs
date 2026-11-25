// Strava, Garmin Connect y la cola de subidas, en el proceso principal (adaptado de Rodillo Virtual).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ipcMain, net, safeStorage, shell } from 'electron'
import { loadIntegrationConfig } from './config.mjs'
import { GarminAuthError, GarminClient, GARMIN_ENDPOINTS, garminEndpointsAt } from './garminClient.mjs'
import { runGarminJob } from './garminJob.mjs'
import { captureGarminTicket, clearGarminWebSession } from './garminLogin.mjs'
import { StravaAuthError, StravaClient, StravaRetryableError } from './stravaClient.mjs'
import { runOAuthFlow } from './oauthServer.mjs'
import { TokenStore } from './tokenStore.mjs'
import { UploadQueue } from './uploadQueue.mjs'

const QUEUE_TICK_MS = 3000
const STRAVA_POLL_MS = 3000
const GARMIN_KEEPALIVE_CHECK_MS = 6 * 3600_000
const GARMIN_KEEPALIVE_MAX_AGE_MS = 24 * 3600_000
const GARMIN_SILENT_LOGIN_TIMEOUT_MS = 30_000

const CONFIG_TEMPLATE = `# Credenciales de tu app de la API de Strava (https://www.strava.com/settings/api).
# En esa página pon "localhost" como Authorization Callback Domain.
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
`

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(value), 'utf8')
  await rename(`${path}.tmp`, path)
}
const errorText = (e) => (e instanceof Error ? e.message : String(e))

/**
 * @param {{ window(): import('electron').BrowserWindow|null, userData: string, extraConfigFiles: string[],
 *           fitPath(id:string): string, activityInfo(id:string): Promise<{name:string, description:string, startedAt:number}> }} deps
 */
export function setupIntegrations(deps) {
  const configFile = join(deps.userData, 'config.env')
  const queueFile = join(deps.userData, 'uploads.json')
  const cipher = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data)
  }
  const stravaTokens = new TokenStore(join(deps.userData, 'strava-tokens.bin'), cipher)
  const stravaBaseUrl = process.env.CINTAPC_STRAVA_BASE_URL
  const garminBaseUrl = process.env.CINTAPC_GARMIN_BASE_URL
  const garmin = new GarminClient({
    tokens: new TokenStore(join(deps.userData, 'garmin-tokens.bin'), cipher),
    endpoints: garminBaseUrl ? garminEndpointsAt(garminBaseUrl) : GARMIN_ENDPOINTS,
    // La pila de red de Chromium: Garmin filtra los clientes que no parecen un navegador.
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)
  })
  const openExternal = (url) => shell.openExternal(url)

  let config = { stravaClientId: null, stravaClientSecret: null, source: null }
  let strava = null

  const send = (channel, payload) => {
    const win = deps.window()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  async function loadConfig() {
    config = await loadIntegrationConfig([configFile, ...deps.extraConfigFiles])
    strava = config.stravaClientId && config.stravaClientSecret
      ? new StravaClient({ clientId: config.stravaClientId, clientSecret: config.stravaClientSecret, tokens: stravaTokens, ...(stravaBaseUrl ? { baseUrl: stravaBaseUrl } : {}) })
      : null
  }

  /** Inicios de sesión en Garmin de uno en uno (comparten la sesión web). */
  let garminLogin = null
  const signInGarmin = (visible) => {
    if (garminLogin?.visible === visible) return garminLogin.result
    const previous = garminLogin?.result.catch(() => false) ?? Promise.resolve(false)
    const result = previous.then(async (alreadyDone) => {
      if (alreadyDone) return true
      const ticket = await captureGarminTicket({
        sso: garmin.endpoints.sso,
        parent: deps.window(),
        visible,
        ...(visible ? {} : { timeoutMs: GARMIN_SILENT_LOGIN_TIMEOUT_MS })
      })
      if (!ticket) return false
      await garmin.signIn(ticket)
      return true
    })
    const entry = { visible, result }
    garminLogin = entry
    result.catch(() => undefined).finally(() => { if (garminLogin === entry) garminLogin = null })
    return result
  }

  /** Si la sesión de Garmin caducó, se intenta recuperar con la sesión web guardada, sin ventana. */
  const recoverGarmin = () => signInGarmin(false).catch(() => false)

  /** Renueva la sesión de Garmin de vez en cuando para que el token de renovación no caduque. */
  const keepGarminAlive = async () => {
    if (!(await garmin.connection())) return
    try {
      await garmin.keepAlive(GARMIN_KEEPALIVE_MAX_AGE_MS)
    } catch (error) {
      if (!(error instanceof GarminAuthError)) return
      if (await recoverGarmin()) await queue.resumeAuth('garmin')
      send('integrations:changed', await status())
    }
  }

  async function status() {
    const connection = strava ? await strava.connection() : null
    const garminConnection = await garmin.connection()
    return {
      strava: {
        configured: strava !== null,
        configPath: configFile,
        configSource: config.source,
        connected: connection !== null,
        athleteName: connection?.athlete?.name || null,
        insecureStorage: !safeStorage.isEncryptionAvailable()
      },
      garmin: { loggedIn: garminConnection !== null, displayName: garminConnection?.displayName ?? null }
    }
  }

  const fromStravaError = (error) => {
    if (error instanceof StravaAuthError) return { kind: 'needsAuth', message: error.message }
    if (error instanceof StravaRetryableError) return { kind: 'retry', message: error.message, ...(error.retryAfterMs ? { delayMs: error.retryAfterMs } : {}) }
    return { kind: 'failed', message: errorText(error) }
  }

  const queue = new UploadQueue({
    persist: (jobs) => writeJson(queueFile, jobs),
    onChange: (jobs) => {
      send('uploads:changed', jobs)
      status().then((value) => send('integrations:changed', value)).catch(() => undefined)
    },
    handlers: {
      async strava(job) {
        if (!strava) return { kind: 'needsAuth', message: 'Falta configurar la app de Strava (config.env).' }
        try {
          if (!job.stravaUploadId) {
            const file = await readFile(deps.fitPath(job.activityId))
            const uploadId = await strava.upload(file, { name: job.name, description: job.description, externalId: `${job.activityId}.fit` })
            return { kind: 'continue', message: 'Strava está procesando la actividad…', delayMs: STRAVA_POLL_MS, patch: { stravaUploadId: uploadId } }
          }
          const state = await strava.uploadStatus(job.stravaUploadId)
          if (state.kind === 'processing') return { kind: 'continue', message: 'Strava está procesando la actividad…', delayMs: STRAVA_POLL_MS }
          if (state.kind === 'ready') return { kind: 'done', message: 'Subida a Strava', url: strava.activityUrl(state.activityId) }
          if (state.kind === 'duplicate') {
            if (state.activityId === null) return { kind: 'done', message: 'Ya estaba en Strava' }
            await strava.updateActivity(state.activityId, { name: job.name, description: job.description })
            return { kind: 'done', message: 'Ya estaba en Strava', url: strava.activityUrl(state.activityId) }
          }
          return { kind: 'failed', message: `Strava no pudo procesarla: ${state.message}` }
        } catch (error) {
          return fromStravaError(error)
        }
      },
      async stravaCheck(job) {
        if (!strava) return { kind: 'needsAuth', message: 'Falta configurar la app de Strava (config.env).' }
        try {
          // Garmin conserva el inicio del FIT con precisión de segundos: no se toca otra actividad cercana.
          const id = await strava.findActivityNear(job.activityStartedAt, 2)
          if (id === null) return { kind: 'notFound', message: 'Esperando a que Garmin la pase a Strava…' }
          await strava.updateActivity(id, { name: job.name, description: job.description })
          return { kind: 'done', message: 'En Strava (llegó desde Garmin)', url: strava.activityUrl(id) }
        } catch (error) {
          return fromStravaError(error)
        }
      },
      garmin(job) {
        return runGarminJob(job, { client: garmin, readFit: (id) => readFile(deps.fitPath(id)), recover: recoverGarmin })
      }
    }
  })

  const tick = () => queue.tick().catch((error) => console.error('No se pudo procesar la cola de subidas', error))
  const ready = (async () => {
    await loadConfig()
    queue.load((await readJson(queueFile)) ?? [])
    setInterval(tick, QUEUE_TICK_MS).unref()
    keepGarminAlive()
    setInterval(() => keepGarminAlive(), GARMIN_KEEPALIVE_CHECK_MS).unref()
  })()

  ipcMain.handle('integrations:status', async () => { await ready; return status() })

  ipcMain.handle('integrations:open-config', async () => {
    const existing = await readFile(configFile, 'utf8').catch(() => null)
    if (existing === null) {
      await mkdir(deps.userData, { recursive: true })
      await writeFile(configFile, CONFIG_TEMPLATE, 'utf8')
    }
    shell.showItemInFolder(configFile)
  })

  ipcMain.handle('integrations:reload-config', async () => {
    await ready
    await loadConfig()
    if (strava) await queue.resumeAuth('strava')
    return status()
  })

  ipcMain.handle('strava:connect', async () => {
    await ready
    const client = strava
    if (!client) throw new Error('Falta configurar la app de Strava (config.env).')
    const { code, scope } = await runOAuthFlow({ buildAuthorizeUrl: (uri, state) => client.authorizeUrl(uri, state), open: openExternal })
    await client.exchangeCode(code, scope)
    await queue.resumeAuth('strava')
    deps.window()?.focus()
    return status()
  })

  ipcMain.handle('strava:disconnect', async () => {
    await ready
    await strava?.disconnect()
    return status()
  })

  ipcMain.handle('garmin:login', async () => {
    await ready
    if (await signInGarmin(true)) await queue.resumeAuth('garmin')
    deps.window()?.focus()
    return status()
  })

  ipcMain.handle('garmin:logout', async () => {
    await garmin.disconnect()
    await clearGarminWebSession()
    return status()
  })

  /** Comprueba de verdad la sesión renovándola (los tokens guardados no dicen si Garmin la revocó). */
  ipcMain.handle('garmin:check', async () => {
    await ready
    await garmin.refresh().catch(() => undefined)
    return status()
  })

  ipcMain.handle('uploads:list', async () => { await ready; return queue.list() })

  ipcMain.handle('uploads:enqueue', async (_event, activityId, plan) => {
    await ready
    if (typeof activityId !== 'string') throw new Error('Actividad no válida')
    const p = { strava: !!plan?.strava, garmin: !!plan?.garmin }
    if (!p.strava && !p.garmin) throw new Error('Activa Garmin Connect o Strava en Ajustes para subir la actividad.')
    const info = await deps.activityInfo(activityId)
    await queue.enqueue({ activityId, name: info.name, description: info.description, startedAt: info.startedAt }, p)
    tick()
    return queue.list()
  })

  ipcMain.handle('uploads:retry', async (_event, id) => {
    await ready
    if (typeof id === 'string') await queue.retry(id)
    tick()
    return queue.list()
  })

  return {
    async removeActivity(id) { await ready; await queue.removeActivity(id) }
  }
}
