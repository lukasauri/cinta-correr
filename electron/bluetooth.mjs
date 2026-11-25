// Puente entre navigator.bluetooth.requestDevice de la ventana y el evento select-bluetooth-device de
// Electron, que no trae selector propio: se envía la lista de dispositivos encontrados a la ventana y se
// espera a que el usuario elija uno (ble:choose). Mismo enfoque que Rodillo Virtual.
import { ipcMain } from 'electron'

export function setupBluetooth(window, log = console.log) {
  const contents = window.webContents
  let active = null
  // Cancelación pedida antes de que llegara el evento de búsqueda: se aplica en cuanto llegue.
  let cancelNext = false

  const finish = (deviceId, reason) => {
    const request = active
    if (!request) return
    active = null
    log(`[ble] búsqueda terminada (${reason}): ${deviceId || 'sin dispositivo'}`)
    request.callback(deviceId)
  }

  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault()
    // El evento se repite mientras dura la búsqueda; la primera vez abre la petición.
    if (!active) {
      if (cancelNext) { cancelNext = false; log('[ble] búsqueda cancelada antes de empezar'); callback(''); return }
      active = { callback }
      log('[ble] búsqueda iniciada')
    } else {
      active.callback = callback
    }
    contents.send('ble:scan-results', devices.map((d) => ({ id: d.deviceId, name: d.deviceName })))
  })

  // Antes de cada búsqueda: una anterior que la ventana abandonó no puede quedarse colgada.
  ipcMain.handle('ble:prepare', () => { finish('', 'nueva búsqueda'); cancelNext = false })

  ipcMain.handle('ble:choose', (_event, id) => {
    if (active) finish(typeof id === 'string' ? id : '', id ? 'elegido por el usuario' : 'cancelada')
    else if (!id) cancelNext = true
  })

  // Algunos dispositivos piden confirmar el emparejamiento en Windows: solo se aceptan confirmaciones simples.
  contents.session.setBluetoothPairingHandler((details, callback) => {
    log(`[ble] solicitud de emparejamiento (${details.pairingKind}) de ${details.deviceId}`)
    callback({ confirmed: details.pairingKind === 'confirm' })
  })
}
