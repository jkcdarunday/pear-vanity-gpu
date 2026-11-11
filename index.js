'use strict'

const Worker = require('bare-worker')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const z32 = require('z32')
const os = require('bare-os')
const HyperMultisig = require('hyper-multisig')
const hid = require('hypercore-id-encoding')
const validation = require('./lib/options')
const runWorkers = require('./lib/workers')

if (!Worker.isMainThread && Worker.workerData && Worker.workerData._vanityWorker) runWorker()

// Automatic mode tries the fastest measured backend first and falls back on any
// failure. HIP leads touch searches; OpenCL leads multisig. Every GPU result is
// verified on the CPU before it is returned.
const AUTO_ORDER = {
  touch: ['hip', 'opencl', 'vulkan'],
  multisig: ['opencl', 'hip', 'vulkan']
}

module.exports = async function findVanityKey(
  start,
  type = 'touch',
  config = undefined,
  options = {}
) {
  validation.prefix(start)

  if (type !== 'touch' && type !== 'multisig') throw new Error('Unknown vanity search type')
  options = validation.validate(options)

  const { backend } = options

  if (type === 'multisig') {
    config = validation.multisig(config)

    const key = HyperMultisig.getCoreKey(config.publicKeys, config.namespace, {
      quorum: config.quorum
    })

    if (hid.normalize(key).startsWith(start)) return config.namespace
  }

  for (const gpu of backend === 'auto' ? AUTO_ORDER[type] : backend === 'cpu' ? [] : [backend]) {
    try {
      return await require('./lib/gpu').search(gpu, start, type, config, options)
    } catch (err) {
      validation.throwIfAborted(options.signal)

      if (backend !== 'auto') throw err

      if (options.onFallback) options.onFallback(err)
    }
  }

  return cpuVanity(start, type, config, options)
}

function cpuVanity(start, type, config, options) {
  const workers = options.workers ?? Math.min(os.availableParallelism() || 1, 32)

  return runWorkers(
    __filename,
    Array.from({ length: workers }, () => ({ _vanityWorker: true, target: start, type, config })),
    options
  )
}

async function multisigVanity(target, config) {
  const { publicKeys, namespace, quorum } = config

  const namespaceBase = namespace.includes('$')
    ? namespace.split('$').slice(0, -1).join('$')
    : namespace

  let attempts = 0

  while (true) {
    attempts++

    // Yield to events to allow worker to handle termination
    if (attempts % 1000 === 0) await new Promise((resolve) => setImmediate(resolve))

    const newNamespace =
      attempts > 1 ? `${namespaceBase}$${z32.encode(crypto.randomBytes(32))}` : namespace

    const key = HyperMultisig.getCoreKey(publicKeys, newNamespace, { quorum })

    const z = hid.normalize(key)

    if (z.startsWith(target)) {
      Worker.parentPort.postMessage({ result: newNamespace })
      return
    }
  }
}

async function touchVanity(target) {
  let attempts = 0

  while (true) {
    attempts++

    // Yield to events to allow worker to handle termination
    if (attempts % 1000 === 0) await new Promise((resolve) => setImmediate(resolve))

    const keyPair = crypto.keyPair()
    const z = z32.encode(Hypercore.key({ signers: [{ publicKey: keyPair.publicKey }] }))

    if (z.startsWith(target)) {
      Worker.parentPort.postMessage({ result: keyPair })
      return
    }

    keyPair.secretKey.fill(0)
  }
}

async function runWorker() {
  if (!Worker.workerData) return

  const { target, type, config } = Worker.workerData

  if (type === 'multisig') await multisigVanity(target, config)

  if (type === 'touch') await touchVanity(target)
}

// Benchmarks measure one GPU backend (Vulkan unless `backend` names another)
// and never fall back.
module.exports.benchmark = function benchmark(type, config, options = {}) {
  const backend =
    options && typeof options === 'object' && options.backend !== undefined
      ? options.backend
      : 'vulkan'

  if (!['vulkan', 'opencl', 'hip'].includes(backend)) {
    return Promise.reject(new Error('Benchmark backend must be vulkan, opencl or hip'))
  }

  return require('./lib/gpu').benchmark(backend, type, config, options)
}
