// Ventana con el inicio de sesión oficial de Garmin: la contraseña se escribe en la web de Garmin y la
// app no la ve ni la guarda. Se recoge el ticket con el que termina (también tras la verificación en dos pasos).
import { BrowserWindow, session } from 'electron'
import { garminSignInUrl, ticketFromHtml, ticketFromUrl } from './garminClient.mjs'

/** Partición propia: guarda la sesión web de Garmin para pedir otro ticket sin contraseña si caducan los tokens. */
export const GARMIN_PARTITION = 'persist:garmin'
const POLL_MS = 500

/** Resuelve el ticket, o null si se cierra la ventana (o, oculta, si no hay sesión web que reutilizar). */
export function captureGarminTicket({ sso, parent, visible, timeoutMs }) {
  const { url, serviceUrl } = garminSignInUrl(sso)
  const web = session.fromPartition(GARMIN_PARTITION)
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      show: visible,
      ...(parent && visible ? { parent, modal: true } : {}),
      title: 'Iniciar sesión en Garmin Connect',
      autoHideMenuBar: true,
      webPreferences: { partition: GARMIN_PARTITION, sandbox: true, contextIsolation: true }
    })
    let done = false
    const finish = (result, error) => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      web.webRequest.onBeforeRequest(null)
      if (!win.isDestroyed()) win.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    // Al terminar, la página navega al servicio con el ticket: se recoge y no se llega a cargar.
    web.webRequest.onBeforeRequest((details, callback) => {
      const found = done ? null : ticketFromUrl(details.url)
      callback(found ? { cancel: true } : {})
      if (found) finish(found)
    })
    // Por si la navegación no llega a hacerse: la página "Success" ya lleva el ticket en su HTML.
    const poll = setInterval(() => {
      if (done || win.isDestroyed()) return
      win.webContents
        .executeJavaScript('document.documentElement ? document.documentElement.outerHTML : ""')
        .then((html) => {
          const found = typeof html === 'string' ? ticketFromHtml(html, serviceUrl) : null
          if (found) finish(found)
        })
        .catch(() => undefined)
    }, POLL_MS)
    const timer = timeoutMs ? setTimeout(() => finish(null), timeoutMs) : undefined
    win.on('closed', () => finish(null))
    win.loadURL(url).catch((error) => {
      if (done) return // cancelar la navegación con el ticket también hace fallar la carga
      if (visible) finish(null, new Error(`No se pudo abrir el inicio de sesión de Garmin: ${String(error)}`))
      else finish(null)
    })
  })
}

/** Olvida la sesión web de Garmin (cookies incluidas). */
export async function clearGarminWebSession() {
  await session.fromPartition(GARMIN_PARTITION).clearStorageData()
}
