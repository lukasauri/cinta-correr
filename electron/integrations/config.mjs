// Credenciales de la app de Strava: variables de entorno o un archivo config.env sencillo.
import { readFile } from 'node:fs/promises'

export function parseEnv(text) {
  const out = {}
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    const closing = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1
    if (closing > 0) value = value.slice(1, closing)
    else value = value.replace(/\s+#.*$/, '')
    out[key] = value
  }
  return out
}

export async function loadIntegrationConfig(files, env = process.env) {
  if (env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET) {
    return { stravaClientId: env.STRAVA_CLIENT_ID, stravaClientSecret: env.STRAVA_CLIENT_SECRET, source: 'variables de entorno' }
  }
  for (const file of files) {
    let text
    try { text = await readFile(file, 'utf8') } catch { continue }
    const values = parseEnv(text)
    const id = values.STRAVA_CLIENT_ID || null
    const secret = values.STRAVA_CLIENT_SECRET || null
    if (id && secret) return { stravaClientId: id, stravaClientSecret: secret, source: file }
  }
  return { stravaClientId: null, stravaClientSecret: null, source: null }
}
