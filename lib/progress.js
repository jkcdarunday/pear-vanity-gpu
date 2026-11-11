'use strict'

// Workers post { progress: candidatesSinceLastReport } about every 250 ms, plus
// an initial zero report (with the device name for GPU workers) once they are
// ready. This turns those reports into onProgress calls for one backend attempt.
// The rate is measured from the first report, so GPU setup and kernel
// compilation do not drag it down.
exports.interval = 250

exports.reporter = function reporter(backend, onProgress) {
  if (!onProgress) return undefined

  const started = Date.now()
  let candidates = 0
  let device
  let baseline = null
  let emitted = 0

  return (message) => {
    const now = Date.now()

    if (typeof message.device === 'string') device = message.device
    if (Number.isSafeInteger(message.progress) && message.progress > 0) {
      candidates += message.progress
    }

    if (baseline === null) {
      baseline = { time: now, candidates }
      return
    }

    if (now - emitted < exports.interval || now === started) return
    emitted = now

    // Workers start staggered, so a short window right after the first report
    // overstates the rate; until a second has passed, average over the attempt.
    const window = now - baseline.time
    const progress = {
      backend,
      candidates,
      seconds: (now - started) / 1000,
      candidatesPerSecond:
        window >= 1000
          ? ((candidates - baseline.candidates) * 1000) / window
          : (candidates * 1000) / (now - started)
    }

    if (device !== undefined) progress.device = device

    onProgress(progress)
  }
}

// Used inside workers: counts candidates and posts them at the report interval.
exports.counter = function counter(post, ready = {}) {
  let pending = 0
  let last = Date.now()

  post({ ...ready, progress: 0 })

  return (count) => {
    pending += count

    const now = Date.now()

    if (now - last < exports.interval) return
    last = now
    post({ progress: pending })
    pending = 0
  }
}
