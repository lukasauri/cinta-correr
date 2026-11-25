// Puente seguro entre la ventana (index.html) y el proceso principal.
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)
const listen = (channel) => (listener) => {
  const handler = (_event, value) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('cintapc', {
  desktop: true,
  version: () => invoke('app:version'),
  ble: {
    onScanResults: listen('ble:scan-results'),
    prepare: () => invoke('ble:prepare'),
    choose: (id) => invoke('ble:choose', id)
  },
  activities: {
    save: (activity) => invoke('activity:save', activity),
    showFit: (id) => invoke('activity:show-fit', id),
    remove: (id) => invoke('activity:remove', id)
  },
  integrations: {
    status: () => invoke('integrations:status'),
    onChange: listen('integrations:changed'),
    openConfig: () => invoke('integrations:open-config'),
    reloadConfig: () => invoke('integrations:reload-config'),
    connectStrava: () => invoke('strava:connect'),
    disconnectStrava: () => invoke('strava:disconnect'),
    garminLogin: () => invoke('garmin:login'),
    garminLogout: () => invoke('garmin:logout'),
    garminCheck: () => invoke('garmin:check'),
    garminHrZones: () => invoke('garmin:hr-zones')
  },
  uploads: {
    list: () => invoke('uploads:list'),
    enqueue: (activityId, plan) => invoke('uploads:enqueue', activityId, plan),
    retry: (jobId) => invoke('uploads:retry', jobId),
    onChange: listen('uploads:changed')
  },
  power: {
    keepAwake: (on) => invoke('power:keep-awake', !!on)
  }
})
