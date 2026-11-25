// Genera el icono de CintaPC (un corredor sobre una cinta) en SVG, PNG e ICO.
// Se ejecuta con Electron para rasterizar con Chromium:  npm run icono
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources')
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const PNG_SIZE = 512

/**
 * Cuadrícula de 64: fondo verde redondeado, cinta (banda, poste y manillar) y corredor blancos.
 * En tamaños pequeños el trazo es más grueso y se quitan detalles para que se siga leyendo.
 */
export function iconSvg(size) {
  const small = size <= 32
  const stroke = small ? 4.6 : 3.4
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
  <!-- Generado por scripts/generar-icono.mjs -->
  <defs>
    <linearGradient id="fondo" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#34d399" />
      <stop offset="1" stop-color="#047857" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#fondo)" />
  <g fill="none" stroke="#ffffff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 50 H52" stroke-width="${small ? 6 : 5}" />
    <path d="M50 49 L44 23 L36 24.5" />
    <path d="M25 21 L22 33" />
    <path d="M24.3 23.5 L30 28 L34.5 25" />
    ${small ? '' : '<path d="M24.3 23.5 L18 27.5 L15.5 24" />'}
    <path d="M22 33 L29.5 37 L28.5 45" />
    <path d="M22 33 L18 39.5 L12 40.5" />
    ${small ? '' : '<path d="M6 20 H13 M4 28 H11" stroke-width="2.4" opacity="0.7" />'}
  </g>
  <circle cx="26.5" cy="13.5" r="${small ? 5 : 4.4}" fill="#ffffff" />
</svg>
`
}

/** ICO con las imágenes en PNG (Windows Vista o posterior). */
function buildIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((image) => image.png)])
}

async function rasterize(win, size) {
  const script = `(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(iconSvg(size)).toString('base64'))}
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = ${size}
    canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size})
    return canvas.toDataURL('image/png').split(',')[1]
  })()`
  return Buffer.from(await win.webContents.executeJavaScript(script), 'base64')
}

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank')
  mkdirSync(outDir, { recursive: true })
  const images = []
  for (const size of ICO_SIZES) images.push({ size, png: await rasterize(win, size) })
  writeFileSync(join(outDir, 'icono.ico'), buildIco(images))
  writeFileSync(join(outDir, 'icono.png'), await rasterize(win, PNG_SIZE))
  writeFileSync(join(outDir, 'icono.svg'), iconSvg(64))
  writeFileSync(join(outDir, 'icono-pequeno.svg'), iconSvg(24))
  console.log(`Iconos generados en ${outDir}`)
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => app.quit())
