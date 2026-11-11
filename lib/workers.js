'use strict'

const Worker = require('bare-worker')
const gracedown = require('pear-gracedown')
const { abortError } = require('./options')

// Resolve only after every worker has exited and released its native resources.
// `progress` receives the workers' { progress } messages (see lib/progress.js).
module.exports = function runWorkers(entry, data, { signal } = {}, progress) {
  return new Promise((resolve, reject) => {
    const workers = []
    let finished = false

    const stop = () => Promise.allSettled(workers.map((worker) => worker.terminate()))
    const unregister = gracedown(stop)
    const settle = (err, result) => {
      if (finished) return
      finished = true

      if (signal) signal.removeEventListener('abort', onAbort)
      stop().then(() => {
        unregister()

        if (err) reject(err)
        else resolve(result)
      })
    }

    const onAbort = () => settle(abortError())

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })

      if (signal.aborted) {
        onAbort()
        return
      }
    }

    try {
      for (const workerData of data) {
        if (finished) break

        const worker = new Worker(entry, { workerData })
        workers.push(worker)
        worker.once('error', (err) => settle(err))
        worker.once('exit', () => settle(new Error('Vanity worker exited without a result')))
        // Keep the port referenced until termination, even after receiving a result.
        worker.on('message', (message) => {
          if (message && typeof message === 'object' && 'progress' in message) {
            if (finished || !progress) return

            try {
              progress(message)
            } catch (err) {
              settle(err)
            }
          } else if (!message || typeof message !== 'object') {
            settle(new Error('Invalid vanity worker response'))
          } else if (message.error) {
            settle(new Error(message.error))
          } else {
            settle(null, message.result)
          }
        })
      }
    } catch (err) {
      settle(err)
    }
  })
}
