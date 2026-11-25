// Cola de subidas (misma lógica que Rodillo Virtual): ejecuta una tarea cada vez cuando le toca, guarda
// el estado en disco y encadena Garmin → comprobación en Strava → subida directa a Strava si no llega o
// si Garmin falla. Así Strava nunca depende de la subida no oficial a Garmin.
//
// Tarea: { id, activityId, target: 'strava'|'garmin'|'stravaCheck', status: 'pending'|'running'|'done'|'failed'|'needsAuth',
//          createdAt, nextAttemptAt, attempts, message, name, description, activityStartedAt,
//          thenStrava?, fallbackQueued?, stravaUploadId?, garminProcessing?, garminChecks?, checksLeft?, url? }

export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000]
/** Cuándo mirar si la actividad subida a Garmin ya está en Strava (desde la anterior). */
export const STRAVA_CHECK_DELAYS_MS = [180_000, 180_000, 240_000]
/** Fallos pasajeros de Garmin tras los que se sube ya a Strava por su cuenta. */
const GARMIN_RETRIES_BEFORE_FALLBACK = 3

function isUploadJob(value) {
  if (!value || typeof value !== 'object') return false
  return (
    ['id', 'activityId', 'message', 'name', 'description'].every((k) => typeof value[k] === 'string') &&
    ['createdAt', 'nextAttemptAt', 'attempts', 'activityStartedAt'].every((k) => typeof value[k] === 'number' && Number.isFinite(value[k])) &&
    ['strava', 'garmin', 'stravaCheck'].includes(String(value.target)) &&
    ['pending', 'running', 'done', 'failed', 'needsAuth'].includes(String(value.status))
  )
}

let counter = 0
const jobId = (now) => `u-${now.toString(36)}-${(counter++).toString(36)}`

export class UploadQueue {
  /** @param {{handlers: Record<string,(job:any)=>Promise<any>>, persist(jobs:any[]):Promise<void>, onChange?(jobs:any[]):void, now?:()=>number}} options */
  constructor(options) {
    this.options = options
    this.jobs = []
    this.busy = false
    this.writing = Promise.resolve()
    this.now = options.now ?? Date.now
  }

  /** Carga lo guardado; una tarea que quedó a medias se vuelve a intentar. */
  load(jobs) {
    this.jobs = (Array.isArray(jobs) ? jobs : [])
      .filter(isUploadJob)
      .map((j) => (j.status === 'running' ? { ...j, status: 'pending', nextAttemptAt: this.now() } : j))
  }

  list() { return this.jobs.map((j) => ({ ...j })) }

  enqueue(activity, plan) {
    let garmin = this.jobs.find((j) => j.activityId === activity.activityId && j.target === 'garmin')
    if (plan.garmin && !garmin) {
      garmin = this.add({ ...activity, target: 'garmin', message: 'En cola para Garmin Connect', thenStrava: plan.strava })
    }
    if (plan.strava) {
      if (plan.garmin && garmin) {
        garmin.thenStrava = true
        if (garmin.status === 'done') this.checkStrava(garmin)
        else if (garmin.status === 'failed' || garmin.status === 'needsAuth' || garmin.attempts >= GARMIN_RETRIES_BEFORE_FALLBACK) {
          this.fallbackToStrava(garmin)
        }
      } else if (!this.hasStrava(activity.activityId)) {
        this.add({ ...activity, target: 'strava', message: 'En cola para Strava' })
      }
    }
    return this.changed()
  }

  retry(id) {
    const job = this.jobs.find((j) => j.id === id)
    if (!job || job.status === 'running' || job.status === 'done') return Promise.resolve()
    if (job.target === 'strava' && job.status === 'failed') delete job.stravaUploadId
    Object.assign(job, { status: 'pending', nextAttemptAt: this.now(), attempts: 0, message: 'En cola para reintentar' })
    return this.changed()
  }

  /** Tras conectar una cuenta, las tareas que esperaban por ella siguen. */
  resumeAuth(service) {
    const targets = service === 'strava' ? ['strava', 'stravaCheck'] : ['garmin']
    for (const job of this.jobs) {
      if (job.status === 'needsAuth' && targets.includes(job.target)) {
        Object.assign(job, { status: 'pending', nextAttemptAt: this.now(), attempts: 0 })
      }
    }
    return this.changed()
  }

  removeActivity(activityId) {
    this.jobs = this.jobs.filter((j) => j.activityId !== activityId)
    return this.changed()
  }

  /** Ejecuta la siguiente tarea que toque, si hay alguna. */
  async tick() {
    if (this.busy) return
    const now = this.now()
    const job = this.jobs.filter((j) => j.status === 'pending' && j.nextAttemptAt <= now).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0]
    if (!job) return
    this.busy = true
    try {
      job.status = 'running'
      await this.changed()
      let outcome
      try {
        outcome = await this.options.handlers[job.target]({ ...job })
      } catch (error) {
        outcome = { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
      this.apply(job.id, outcome)
      await this.changed()
    } catch (error) {
      if (job.status === 'running') job.status = 'pending'
      throw error
    } finally {
      this.busy = false
    }
  }

  apply(id, outcome) {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return
    const now = this.now()
    switch (outcome.kind) {
      case 'done':
        Object.assign(job, { status: 'done', message: outcome.message, attempts: 0, ...(outcome.url ? { url: outcome.url } : {}) })
        if (job.target === 'garmin') this.checkStrava(job)
        return
      case 'continue':
        Object.assign(job, { status: 'pending', message: outcome.message, nextAttemptAt: now + outcome.delayMs, attempts: 0, ...outcome.patch })
        return
      case 'retry': {
        const delay = outcome.delayMs ?? RETRY_DELAYS_MS[Math.min(job.attempts, RETRY_DELAYS_MS.length - 1)]
        Object.assign(job, { status: 'pending', message: outcome.message, nextAttemptAt: now + delay, attempts: job.attempts + 1 })
        if (job.target === 'garmin' && job.attempts >= GARMIN_RETRIES_BEFORE_FALLBACK) this.fallbackToStrava(job)
        return
      }
      case 'needsAuth':
        Object.assign(job, { status: 'needsAuth', message: outcome.message })
        if (job.target === 'garmin') this.fallbackToStrava(job)
        return
      case 'failed':
        Object.assign(job, { status: 'failed', message: outcome.message })
        if (job.target === 'garmin') this.fallbackToStrava(job)
        if (job.target === 'stravaCheck') this.directStrava(job)
        return
      case 'notFound': {
        const left = (job.checksLeft ?? 1) - 1
        if (left > 0) {
          const delay = STRAVA_CHECK_DELAYS_MS[STRAVA_CHECK_DELAYS_MS.length - left] ?? STRAVA_CHECK_DELAYS_MS.at(-1)
          Object.assign(job, { status: 'pending', message: outcome.message, checksLeft: left, nextAttemptAt: now + delay })
        } else {
          Object.assign(job, { status: 'done', message: 'No llegó desde Garmin: se sube directamente a Strava', checksLeft: 0 })
          this.directStrava(job)
        }
      }
    }
  }

  /** Si Garmin no puede, Strava se sube por su cuenta (una sola vez). */
  fallbackToStrava(job) {
    if (!job.thenStrava || job.fallbackQueued) return
    job.fallbackQueued = true
    this.directStrava(job, 'Garmin no está disponible: se sube directamente a Strava')
  }

  hasStrava(activityId) {
    return this.jobs.some((j) => j.activityId === activityId && j.target !== 'garmin')
  }

  checkStrava(job) {
    if (!job.thenStrava || this.hasStrava(job.activityId)) return
    this.add({ ...this.activityOf(job), target: 'stravaCheck', message: 'Esperando a que Garmin la pase a Strava', checksLeft: STRAVA_CHECK_DELAYS_MS.length }, STRAVA_CHECK_DELAYS_MS[0])
  }

  directStrava(job, message = 'En cola para Strava') {
    if (this.jobs.some((j) => j.activityId === job.activityId && j.target === 'strava')) return
    this.add({ ...this.activityOf(job), target: 'strava', message })
  }

  activityOf(job) {
    return { activityId: job.activityId, name: job.name, description: job.description, startedAt: job.activityStartedAt }
  }

  add(fields, delayMs = 0) {
    const now = this.now()
    const { startedAt, ...rest } = fields
    const job = { id: jobId(now), status: 'pending', createdAt: now, nextAttemptAt: now + delayMs, attempts: 0, activityStartedAt: startedAt, ...rest }
    this.jobs.push(job)
    return job
  }

  changed() {
    const snapshot = this.list()
    this.options.onChange?.(snapshot)
    const write = this.writing.then(() => this.options.persist(snapshot))
    this.writing = write.catch(() => undefined)
    return write
  }
}
