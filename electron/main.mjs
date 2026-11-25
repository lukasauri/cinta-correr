// CintaPC — proceso principal de Electron: ventana, Bluetooth, archivos FIT y subidas a Garmin/Strava.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, shell } from 'electron'
import { setupBluetooth } from './bluetooth.mjs'
import { encodeRunFit } from './fit.mjs'
import { setupIntegrations } from './integrations/service.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Para pruebas automáticas: datos aislados y ventana fuera de la pantalla.
if (process.env.CINTAPC_USER_DATA) app.setPath('userData', process.env.CINTAPC_USER_DATA)
const offscreen = process.env.CINTAPC_OFFSCREEN === '1'

let mainWindow = null
let integrations = null
let blockerId = null

const activitiesDir = () => join(app.getPath('userData'), 'activities')
const validId = (id) => typeof id === 'string' && /^[a-z0-9_-]{4,64}$/i.test(id)
const fitPath = (id) => join(activitiesDir(), `${id}.fit`)
const infoPath = (id) => join(activitiesDir(), `${id}.json`)

function keepAwake(on) {
  if (on && blockerId === null) blockerId = powerSaveBlocker.start('prevent-display-sleep')
  if (!on && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0f14',
    title: 'CintaPC',
    ...(offscreen ? { x: -32000, y: -32000, skipTaskbar: true } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // El entrenamiento no puede frenarse si la ventana queda tapada o minimizada.
      backgroundThrottling: false
    }
  })
  setupBluetooth(mainWindow)
  mainWindow.once('ready-to-show', () => (offscreen ? mainWindow?.showInactive() : mainWindow?.show()))
  mainWindow.on('closed', () => { mainWindow = null; keepAwake(false) })
  // Los enlaces externos (Strava, Garmin) se abren en el navegador del sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // Cerrar con una sesión en marcha: Electron cancelaría el cierre sin decir nada. Se pregunta y,
  // si se acepta, la ventana para la cinta, guarda la sesión y se cierra ella misma.
  mainWindow.webContents.on('will-prevent-unload', () => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Terminar la sesión y cerrar', 'Seguir corriendo'],
      defaultId: 1,
      cancelId: 1,
      title: 'CintaPC',
      message: 'Hay una sesión en marcha',
      detail: 'Si cierras, se parará la cinta y la sesión se guardará en el historial.'
    })
    if (choice === 0) mainWindow?.webContents.executeJavaScript('window.__closeSafely && window.__closeSafely()').catch(() => mainWindow?.destroy())
  })
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools()
  })
  mainWindow.loadFile(join(root, 'index.html'))
}

function setupIpc() {
  ipcMain.handle('power:keep-awake', (_e, on) => keepAwake(!!on))
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('activity:save', async (_e, a) => {
    if (!a || !validId(a.id) || !Number.isFinite(a.start) || !Array.isArray(a.samples)) throw new Error('Actividad no válida')
    const fit = encodeRunFit(a)
    await mkdir(activitiesDir(), { recursive: true })
    // Nombre temporal único: dos guardados a la vez (fin de sesión + "Mostrar FIT") no chocan.
    const tmp = `${fitPath(a.id)}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(tmp, fit)
    await rename(tmp, fitPath(a.id))
    const info = { name: String(a.name || 'Carrera en cinta').slice(0, 200), description: String(a.description || '').slice(0, 2000), startedAt: a.start }
    await writeFile(infoPath(a.id), JSON.stringify(info), 'utf8')
    return { fitPath: fitPath(a.id), bytes: fit.length }
  })

  ipcMain.handle('activity:show-fit', (_e, id) => {
    if (!validId(id) || !existsSync(fitPath(id))) throw new Error('No se encuentra el archivo FIT de esta sesión')
    shell.showItemInFolder(fitPath(id))
  })

  ipcMain.handle('activity:remove', async (_e, id) => {
    if (!validId(id)) return
    await rm(fitPath(id), { force: true })
    await rm(infoPath(id), { force: true })
    await integrations?.removeActivity(id)
  })
}

// Una sola ventana: la cinta solo admite una conexión Bluetooth a la vez.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    setupIpc()
    integrations = setupIntegrations({
      window: () => mainWindow,
      userData: app.getPath('userData'),
      extraConfigFiles: [join(root, '.env')],
      fitPath,
      activityInfo: async (id) => {
        if (!validId(id)) throw new Error('Actividad no válida')
        return JSON.parse(await readFile(infoPath(id), 'utf8'))
      }
    })
    createWindow()
  })
  app.on('window-all-closed', () => app.quit())
}
