'use strict'

// Bare has no AbortController, so the Node bridge host and the command-line tool
// use this minimal signal shape, which lib/options.js accepts.
module.exports = function createSignal() {
  const listeners = new Set()

  return {
    aborted: false,
    addEventListener(type, listener) {
      if (type === 'abort') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'abort') listeners.delete(listener)
    },
    abort() {
      if (this.aborted) return
      this.aborted = true
      for (const listener of [...listeners]) listener()
    }
  }
}
