'use strict'

const Worker = require('bare-worker')
const progress = require('./progress')

main().catch((err) => Worker.parentPort.postMessage({ error: err.message }))

async function main() {
  const {
    backend,
    configuration,
    addon,
    allowSoftware,
    batchSize,
    batches,
    cacheDirectory,
    progress: reporting
  } = Worker.workerData
  const binding = addon ? new Bare.Addon(URL.pathToFileURL(addon)).exports : require('#binding')
  const handle = binding.create(
    configuration,
    backend,
    allowSoftware,
    batchSize,
    batches,
    cacheDirectory
  )
  let result

  try {
    // Older addons passed through `addon` may lack info(); they run without progress.
    const info =
      reporting && typeof binding.info === 'function' ? JSON.parse(binding.info(handle)) : null
    const count = info
      ? progress.counter((message) => Worker.parentPort.postMessage(message), {
          device: info.device
        })
      : null
    // The first step is a small known-answer self-test, not search work.
    let selfTest = true

    for (;;) {
      result = binding.step(handle)

      if (result !== null) break

      if (count && !selfTest) count(info.batchSize)
      selfTest = false
      // Keep GPU calls off the main thread and allow cancellation between batches.
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    binding.close(handle)
  }
  Worker.parentPort.postMessage({ result })
}
