// Lanzador de Windows (mismo esquema que Rodillo Virtual): instala las dependencias si hace falta y abre
// la app sin dejar una terminal abierta. No hay paso de compilación.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const logDir = join(root, 'logs')
const logPath = join(logDir, 'inicio.log')

function dependenciesReady() {
  try {
    const expected = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages
    const installed = JSON.parse(readFileSync(join(root, 'node_modules', '.package-lock.json'), 'utf8')).packages
    return existsSync(electronExe) &&
      Object.entries(expected).every(([path, pkg]) => !path || (pkg.optional && !installed[path]) || installed[path]?.version === pkg.version)
  } catch {
    return false
  }
}

function run(command) {
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], { cwd: root, stdio: 'inherit' })
  if (result.error) throw new Error(`No se pudo ejecutar: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`Falló la preparación de la app (${command}).`)
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Abre "Iniciar CintaPC.cmd" desde Windows.')
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Se necesita Node.js 22.12 o posterior. Actualízalo desde https://nodejs.org/.')
  console.log('Preparando CintaPC...')
  if (!dependenciesReady()) {
    console.log('Instalando lo necesario. La primera vez puede tardar unos minutos...')
    run('npm.cmd ci --include=dev --no-audit --no-fund')
    // Electron 44+ ya no descarga su binario al instalarse: hay que pedirlo explícitamente.
    if (!existsSync(electronExe)) run('node.exe node_modules\\electron\\install.js')
    if (!dependenciesReady()) throw new Error('La instalación no ha preparado Electron correctamente. Revisa los mensajes anteriores.')
  }
  console.log('Abriendo CintaPC...')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  mkdirSync(logDir, { recursive: true })
  const log = openSync(logPath, 'w')
  let app
  try {
    app = spawn(electronExe, [root], { cwd: root, env, detached: true, stdio: ['ignore', log, log] })
  } finally {
    closeSync(log)
  }
  await new Promise((resolveStarted, reject) => {
    const timer = setTimeout(resolveStarted, 1500)
    app.once('error', (error) => { clearTimeout(timer); reject(new Error(`No se pudo abrir la app: ${error.message}`)) })
    app.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveStarted()
      else reject(new Error(`La app se cerró al arrancar. Consulta el registro: ${logPath}`))
    })
  })
  app.unref()
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
