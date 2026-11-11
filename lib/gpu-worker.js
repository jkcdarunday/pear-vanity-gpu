'use strict'

const Worker = require('bare-worker')

main().catch((err) => Worker.parentPort.postMessage({ error: err.message }))

async function main() {
  const { backend, configuration, addon, allowSoftware, batchSize, batches, cacheDirectory } =
    Worker.workerData
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
    for (;;) {
      result = binding.step(handle)

      if (result !== null) break
      // Keep GPU calls off the main thread and allow cancellation between batches.
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    binding.close(handle)
  }
  Worker.parentPort.postMessage({ result })
}
