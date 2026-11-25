// Autorización OAuth de Strava con redirección a un servidor local temporal (127.0.0.1, puerto libre).
// Comprueba el parámetro `state` para que nadie pueda colar un código ajeno.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

const page = (title, text) =>
  `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:Segoe UI,sans-serif;background:#0b0f14;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h1 style="font-size:22px">${title}</h1><p>${text}</p></div></body></html>`

export async function runOAuthFlow({ buildAuthorizeUrl, open, timeoutMs }) {
  const state = randomBytes(16).toString('hex')
  const running = {}
  let timer
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('No se completó la autorización a tiempo')), timeoutMs ?? 5 * 60_000)
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/strava/callback') { res.writeHead(404).end(); return }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        if (url.searchParams.get('state') !== state) {
          res.end(page('Autorización no válida', 'Vuelve a la app e inténtalo de nuevo.'))
          return
        }
        clearTimeout(timer)
        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        if (error || !code) {
          res.end(page('Autorización cancelada', 'Puedes cerrar esta pestaña.'))
          reject(new Error(error === 'access_denied' ? 'Has cancelado la autorización en Strava' : 'Strava no devolvió el código'))
          return
        }
        res.end(page('Autorización recibida', 'Vuelve a CintaPC. Ya puedes cerrar esta pestaña.'))
        resolve({ code, scope: url.searchParams.get('scope') ?? '' })
      })
      running.server = server
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        const redirectUri = `http://127.0.0.1:${port}/strava/callback`
        Promise.resolve().then(() => open(buildAuthorizeUrl(redirectUri, state))).catch(reject)
      })
    })
  } finally {
    clearTimeout(timer)
    running.server?.close()
  }
}
