// CintaPC — lanzador con actualización automática (lo que abre el acceso directo del escritorio).
//
// Vive en %LOCALAPPDATA%\CintaPC\lanzar.mjs y usa su propio Node (carpeta node\). Cada vez que se abre:
//   1. Mira en GitHub si hay una versión publicada más nueva que la instalada.
//   2. Si la hay, la descarga, prepara sus dependencias y la cambia por la anterior.
//      (Si algo falla, se queda la versión que había: nunca deja la app rota.)
//   3. Abre la app. Sin internet, abre directamente la versión instalada.
// Con --instalar, además crea los accesos directos del escritorio y del menú Inicio.
//
// Solo usa módulos de Node (sin dependencias): así puede actualizarse a sí mismo.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'lukasauri/cinta-correr'
const BASE = process.env.CINTAPC_BASE || dirname(fileURLToPath(import.meta.url))
const APP = join(BASE, 'app')
const NEW = join(BASE, 'app-nueva')
const OLD = join(BASE, 'app-anterior')
const TMP = join(BASE, 'descarga')
const LOG = join(BASE, 'registro.log')
const NODE_DIR = dirname(process.execPath)
const NPM_CLI = join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
const TAR = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
const installMode = process.argv.includes('--instalar')

process.chdir(BASE) // nunca dentro de app\, que se renombra al actualizar

function log(msg) {
  console.log(`  ${msg}`)
  try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch { }
}

const electronExe = (dir) => join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }
const installedVersion = () => readJson(join(APP, 'package.json'))?.version ?? null

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) }
  return false
}

async function fetchWithTimeout(url, ms) {
  return fetch(url, { headers: { 'User-Agent': 'CintaPC-actualizador', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(ms) })
}

/** Última versión publicada en GitHub, o null si no se puede saber (sin internet, etc.). */
async function latestRelease() {
  try {
    const res = await fetchWithTimeout(`https://api.github.com/repos/${REPO}/releases/latest`, 10_000)
    if (!res.ok) { log(`GitHub respondió ${res.status} al buscar versiones`); return null }
    const data = await res.json()
    return { version: String(data.tag_name).replace(/^v/, ''), zip: data.zipball_url }
  } catch (e) {
    log(`No se pudo comprobar si hay actualizaciones (${e.message})`)
    return null
  }
}

function run(args, cwd) {
  const env = { ...process.env, PATH: `${NODE_DIR};${process.env.PATH || ''}` }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env })
  if (r.status !== 0) throw new Error(`Falló: node ${args.join(' ')}`)
}

/** Instala las dependencias (Electron incluido) en una carpeta de la app. */
function installDependencies(dir) {
  log('Preparando la app (puede tardar unos minutos)...')
  run([NPM_CLI, 'ci', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error'], dir)
  // Electron 44+ ya no descarga su programa al instalarse: hay que pedirlo.
  if (!existsSync(electronExe(dir))) run([join(dir, 'node_modules', 'electron', 'install.js')], dir)
  if (!existsSync(electronExe(dir))) throw new Error('No se pudo preparar Electron')
}

/** Las dependencias son iguales si el lockfile coincide (sin contar la versión de la propia app). */
function sameDependencies(dirA, dirB) {
  const deps = (dir) => {
    const lock = readJson(join(dir, 'package-lock.json'))
    if (!lock?.packages) return null
    const { '': _root, ...rest } = lock.packages
    return JSON.stringify(rest)
  }
  const a = deps(dirA)
  return a !== null && a === deps(dirB)
}

function tryRename(from, to, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try { renameSync(from, to); return true } catch (e) {
      if (i === attempts) { log(`No se pudo mover ${from} (${e.code})`); return false }
      spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'ping -n 2 127.0.0.1 >nul'])
    }
  }
  return false
}

async function update(release) {
  log(`Descargando la versión ${release.version}...`)
  rmSync(TMP, { recursive: true, force: true })
  rmSync(NEW, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const res = await fetchWithTimeout(release.zip, 120_000)
  if (!res.ok) throw new Error(`Descarga fallida (${res.status})`)
  const zip = join(TMP, 'app.zip')
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
  const x = spawnSync(TAR, ['-xf', zip, '-C', TMP], { stdio: 'inherit' })
  if (x.status !== 0) throw new Error('No se pudo descomprimir la descarga')
  const top = readdirSync(TMP, { withFileTypes: true }).find((d) => d.isDirectory())
  if (!top || !existsSync(join(TMP, top.name, 'package.json'))) throw new Error('La descarga no contiene la app')
  renameSync(join(TMP, top.name), NEW)
  rmSync(TMP, { recursive: true, force: true })

  const hadApp = existsSync(APP)
  rmSync(OLD, { recursive: true, force: true })
  // Si la app está abierta, Windows no deja mover su carpeta: se actualizará la próxima vez.
  if (hadApp && !tryRename(APP, OLD)) {
    rmSync(NEW, { recursive: true, force: true })
    log('CintaPC ya está abierta: la actualización se hará la próxima vez que la abras.')
    return false
  }
  try {
    if (hadApp && existsSync(join(OLD, 'node_modules')) && existsSync(electronExe(OLD)) && sameDependencies(OLD, NEW)) {
      renameSync(join(OLD, 'node_modules'), join(NEW, 'node_modules')) // mismas dependencias: se reutilizan
    } else {
      installDependencies(NEW)
    }
    renameSync(NEW, APP)
  } catch (e) {
    // Vuelta atrás: se recupera la versión anterior tal cual estaba.
    log(`La actualización ha fallado (${e.message}). Se mantiene la versión anterior.`)
    if (hadApp) {
      if (existsSync(join(NEW, 'node_modules')) && !existsSync(join(OLD, 'node_modules'))) {
        try { renameSync(join(NEW, 'node_modules'), join(OLD, 'node_modules')) } catch { }
      }
      if (!existsSync(APP)) tryRename(OLD, APP)
    }
    rmSync(NEW, { recursive: true, force: true })
    if (!hadApp) throw e
    return false
  }
  rmSync(OLD, { recursive: true, force: true })
  // El propio lanzador también se actualiza (se usará a partir de la próxima vez).
  try { copyFileSync(join(APP, 'scripts', 'lanzar.mjs'), join(BASE, 'lanzar.mjs')) } catch { }
  log(`CintaPC actualizada a la versión ${release.version}.`)
  return true
}

const appIcon = () => (existsSync(join(APP, 'resources', 'icono.ico')) ? join(APP, 'resources', 'icono.ico') : electronExe(APP))
const ICON_MARK = join(BASE, 'icono-v1')

/**
 * Crea (onlyExisting = false) o actualiza (true) los accesos directos del escritorio y del menú Inicio.
 * Actualizar solo toca los que existen: si se borró uno, no se vuelve a crear.
 */
function createShortcuts(onlyExisting = false) {
  if (process.env.CINTAPC_SIN_ACCESOS) return true
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))
foreach ($dir in $targets) {
  $lnk = Join-Path $dir 'CintaPC.lnk'
  if (${onlyExisting ? '$true' : '$false'} -and -not (Test-Path $lnk)) { continue }
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = '${process.execPath.replace(/'/g, "''")}'
  $s.Arguments = '"${join(BASE, 'lanzar.mjs').replace(/'/g, "''")}"'
  $s.WorkingDirectory = '${BASE.replace(/'/g, "''")}'
  $s.IconLocation = '${appIcon().replace(/'/g, "''")},0'
  $s.Description = 'CintaPC - cinta de correr'
  $s.Save()
}`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit' })
  if (!onlyExisting) log(r.status === 0 ? 'Acceso directo "CintaPC" creado en el escritorio y en el menú Inicio.' : 'No se pudo crear el acceso directo.')
  return r.status === 0
}

async function launch() {
  if (process.env.CINTAPC_NO_ABRIR) { log('(prueba) no se abre la app'); return }
  log('Abriendo CintaPC...')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const out = openSync(join(BASE, 'app.log'), 'w')
  let child
  try {
    child = spawn(electronExe(APP), [APP], { cwd: APP, env, detached: true, stdio: ['ignore', out, out] })
  } finally {
    closeSync(out)
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 2000)
    child.once('error', (e) => { clearTimeout(timer); reject(new Error(`No se pudo abrir la app: ${e.message}`)) })
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`La app se cerró al arrancar (código ${code}). Mira ${join(BASE, 'app.log')}`)) })
  })
  child.unref()
}

async function main() {
  console.log('\n  CintaPC\n  -------')
  log('Buscando actualizaciones...')
  const current = installedVersion()
  const release = await latestRelease()
  if (release && (!current || newer(release.version, current) || !existsSync(electronExe(APP)))) {
    try { await update(release) }
    catch (e) { if (!existsSync(electronExe(APP))) throw e; log(`No se pudo actualizar (${e.message}). Se abre la versión instalada.`) }
  } else if (current) {
    log(`Versión ${current}: está al día.`)
  }
  if (!existsSync(join(APP, 'package.json'))) throw new Error('CintaPC no está instalada y no se ha podido descargar. Comprueba la conexión a internet y vuelve a intentarlo.')
  if (!existsSync(electronExe(APP))) installDependencies(APP) // instalación a medias: se completa
  if (installMode) { createShortcuts(); try { writeFileSync(ICON_MARK, '') } catch { } }
  else if (!existsSync(ICON_MARK) && existsSync(join(APP, 'resources', 'icono.ico'))) {
    // Instalaciones anteriores al icono propio: se cambia el icono de los accesos directos una vez.
    if (createShortcuts(true)) { try { writeFileSync(ICON_MARK, '') } catch { } }
  }
  await launch()
}

main().catch((e) => {
  log(`ERROR: ${e.message}`)
  console.log('\n  Algo ha fallado. Pulsa una tecla para cerrar y vuelve a intentarlo.')
  console.log('  Si se repite, envía el archivo registro.log de esta carpeta:', BASE)
  spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'pause >nul'], { stdio: 'inherit' })
  process.exitCode = 1
})
