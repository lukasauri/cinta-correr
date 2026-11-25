// Guarda un secreto (tokens OAuth) cifrado en disco con el cifrado del sistema (DPAPI en Windows).
// Si no hay cifrado disponible no se escribe nada en claro: el secreto vive solo en memoria.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class TokenStore {
  /** @param {string} path @param {{available():boolean, encrypt(t:string):Buffer, decrypt(b:Buffer):string}} cipher */
  constructor(path, cipher) {
    this.path = path
    this.cipher = cipher
    this.memory = null
    this.loaded = false
    this.loading = null
    this.writing = Promise.resolve()
  }

  async load() {
    if (this.loaded) return this.memory
    if (!this.loading) {
      this.loading = (async () => {
        let value = null
        if (this.cipher.available()) {
          try { value = JSON.parse(this.cipher.decrypt(await readFile(this.path))) } catch { /* primera vez o archivo ilegible */ }
        }
        if (!this.loaded) this.memory = value
        this.loaded = true
        return this.memory
      })()
    }
    return this.loading
  }

  async save(value) {
    this.memory = value
    this.loaded = true
    const encrypted = this.cipher.available() ? this.cipher.encrypt(JSON.stringify(value)) : null
    return this.write(async () => {
      if (!encrypted) { await rm(this.path, { force: true }); return }
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(`${this.path}.tmp`, encrypted)
      await rename(`${this.path}.tmp`, this.path)
    })
  }

  async clear() {
    this.memory = null
    this.loaded = true
    return this.write(() => rm(this.path, { force: true }))
  }

  write(run) {
    const next = this.writing.then(run)
    this.writing = next.catch(() => undefined)
    return next
  }
}
