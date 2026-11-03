'use strict'
// The poll state (state.json) and the names cache (names.json) live in files of the plugin's project
// data folder (design "Polling"), not in ctx.storage: every kept space with its rows can come near
// ctx.storage's 1 MiB per value. One writer (this project's host), so a temp
// file plus rename is enough: a host killed mid-write leaves the old file whole. (From bronos.gmail, which has it from bronos.jira.)

const fs = require('node:fs')
const path = require('node:path')

function jsonFile(dir, name) {
  const file = path.join(dir, name)
  let chain = Promise.resolve()
  return {
    file,
    /** The stored value, or `fallback` when the file is missing or unreadable (a crash, a hand edit). */
    async read(fallback) {
      try {
        return JSON.parse(await fs.promises.readFile(file, 'utf8'))
      } catch {
        return fallback
      }
    },
    /** Write `value`; calls are queued so two writes never interleave. */
    write(value) {
      const text = JSON.stringify(value)
      chain = chain.then(async () => {
        await fs.promises.mkdir(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await fs.promises.writeFile(tmp, text, { mode: 0o600 })
        await fs.promises.rename(tmp, file)
      })
      // A failed write must not poison the queue for the next one; the caller still hears it.
      const done = chain
      chain = chain.catch(() => {})
      return done
    },
    /** Resolves when every queued write has finished. */
    flush() {
      return chain
    },
  }
}

module.exports = { jsonFile }
