// Tarea de subida a Garmin: sube el .FIT y, cuando Garmin la tiene procesada, la enlaza y le pone el
// nombre y la descripción de la app. Una vez subida ya no puede fallar.

export const GARMIN_FIND_DELAY_MS = 5000
export const GARMIN_FIND_CHECKS = 12

/** @param {{client: import('./garminClient.mjs').GarminClient, readFit(id:string): Promise<Uint8Array>, recover(): Promise<boolean>}} deps */
export async function runGarminJob(job, deps) {
  const { client } = deps
  const processing = (checks) => ({
    kind: 'continue',
    message: 'Garmin está procesando la actividad…',
    delayMs: GARMIN_FIND_DELAY_MS,
    patch: { garminProcessing: true, garminChecks: checks }
  })
  const uploaded = async (id) => {
    await client.describeActivity(id, { name: job.name, description: job.description }).catch(() => undefined)
    return { kind: 'done', message: 'Subida a Garmin Connect', url: client.activityUrl(id) }
  }

  if (job.garminProcessing) {
    const checks = (job.garminChecks ?? 0) + 1
    const id = await client.findActivity(job.activityStartedAt).catch(() => null)
    if (id) return uploaded(id)
    return checks < GARMIN_FIND_CHECKS ? processing(checks) : { kind: 'done', message: 'Subida a Garmin Connect' }
  }

  const file = await deps.readFit(job.activityId)
  const upload = () => client.upload(file, `${job.activityId}.fit`)
  let result = await upload()
  if (result.kind === 'needsLogin' && (await deps.recover())) result = await upload()
  switch (result.kind) {
    case 'done':
      return result.activityId ? uploaded(result.activityId) : processing(0)
    case 'duplicate': {
      const id = result.activityId ?? (await client.findActivity(job.activityStartedAt).catch(() => null))
      return { kind: 'done', message: 'Ya estaba en Garmin Connect', ...(id ? { url: client.activityUrl(id) } : {}) }
    }
    case 'needsLogin':
      return { kind: 'needsAuth', message: 'Inicia sesión en Garmin Connect (Ajustes).' }
    default:
      return result.retryable ? { kind: 'retry', message: result.message } : { kind: 'failed', message: result.message }
  }
}
