// Publica una versión nueva de CintaPC: la que recibirá la app instalada al abrirse.
//
//   npm run publicar                 -> sube el último número (0.2.0 -> 0.2.1)
//   npm run publicar -- menor        -> 0.2.1 -> 0.3.0
//   npm run publicar -- 1.0.0 "Notas de la versión"
//
// Comprueba que todo está guardado en git y que las pruebas pasan, cambia la versión, crea el
// commit y la etiqueta, lo sube a GitHub y crea la "release" con el instalador adjunto.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit' })
  if (r.status !== 0) throw new Error(`Falló: ${cmd} ${args.join(' ')}${r.stderr ? `\n${r.stderr}` : ''}`)
  return (r.stdout || '').trim()
}

function nextVersion(current, arg) {
  const [ma, mi, pa] = current.split('.').map(Number)
  if (!arg || arg === 'parche') return `${ma}.${mi}.${pa + 1}`
  if (arg === 'menor') return `${ma}.${mi + 1}.0`
  if (arg === 'mayor') return `${ma + 1}.0.0`
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg
  throw new Error(`Versión no válida: ${arg}`)
}

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true })
if (branch !== 'main') throw new Error(`Publica desde la rama main (estás en ${branch}).`)
if (sh('git', ['status', '--porcelain'], { capture: true })) throw new Error('Hay cambios sin guardar en git: haz commit antes de publicar.')

const pkgPath = join(root, 'package.json'), lockPath = join(root, 'package-lock.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const version = nextVersion(pkg.version, process.argv[2])
const notes = process.argv[3] || ''

console.log(`\nPublicando CintaPC ${pkg.version} -> ${version}\n`)
sh(process.execPath, ['--test', 'tests/fit.test.mjs', 'tests/integrations.test.mjs'])

pkg.version = version
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
lock.version = version
if (lock.packages?.['']) lock.packages[''].version = version
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')

const trailer = process.env.PUBLICAR_TRAILER ? `\n\n${process.env.PUBLICAR_TRAILER}` : ''
sh('git', ['commit', '-am', `Versión ${version}${trailer}`])
sh('git', ['tag', `v${version}`])
sh('git', ['push', 'origin', 'main', '--tags'])
sh('gh', ['release', 'create', `v${version}`, 'Instalar CintaPC.bat', '--title', `CintaPC ${version}`,
  ...(notes ? ['--notes', notes] : ['--generate-notes'])])
console.log(`\nListo: la versión ${version} se instalará sola la próxima vez que se abra CintaPC.`)
