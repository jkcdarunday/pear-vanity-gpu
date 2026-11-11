'use strict'

const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const HyperMultisig = require('hyper-multisig')
const z32 = require('z32')
const { benchmark } = require('../index')

// Fixed-work throughput measurements, shared by `npm run benchmark` and
// `pear-vanity-gpu benchmark`. Results are printed as JSON, one per backend.
exports.usage =
  'Usage: pear-vanity-gpu benchmark [touch|multisig] [--backend cpu|vulkan|opencl|hip|both|all|a,b] [--batch N] [--batches N] [--allow-software]'

exports.run = async function run(args) {
  args = [...args]
  const type = args.shift() || 'touch'
  let backend = 'vulkan'
  const options = {
    allowSoftware: false
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--backend' && i + 1 < args.length) backend = args[++i]
    else if (args[i] === '--allow-software') options.allowSoftware = true
    else if (args[i] === '--batch' && i + 1 < args.length) options.batchSize = Number(args[++i])
    else if (args[i] === '--batches' && i + 1 < args.length) options.batches = Number(args[++i])
    else {
      throw new Error(exports.usage)
    }
  }

  const backends =
    backend === 'both'
      ? ['cpu', 'vulkan']
      : backend === 'all'
        ? ['cpu', 'vulkan', 'opencl', 'hip']
        : backend.split(',')

  if (backends.some((name) => !['cpu', 'vulkan', 'opencl', 'hip'].includes(name))) {
    throw new Error('Unknown benchmark backend')
  }
  if (!['touch', 'multisig'].includes(type)) throw new Error('Unknown benchmark type')

  options.batchSize ??= 65536
  options.batches ??= 10

  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 64 ||
    options.batchSize > 1048576
  ) {
    throw new Error('Batch size must be between 64 and 1048576')
  }

  if (!Number.isInteger(options.batches) || options.batches < 1 || options.batches > 100000) {
    throw new Error('Batches must be between 1 and 100000')
  }

  const config =
    type === 'multisig'
      ? {
          publicKeys: Array.from({ length: 3 }, () => crypto.keyPair().publicKey),
          namespace: 'vanity-benchmark',
          quorum: 2
        }
      : undefined
  for (const name of backends) {
    if (name === 'cpu') {
      console.log(JSON.stringify(cpuBenchmark(type, config, options), null, 2))
      continue
    }

    const started = Date.now()
    const stats = await benchmark(type, config, { ...options, backend: name })
    const totalSeconds = (Date.now() - started) / 1000

    console.log(
      JSON.stringify(
        {
          ...stats,
          totalSeconds,
          setupAndTeardownSeconds: Math.max(0, totalSeconds - stats.seconds)
        },
        null,
        2
      )
    )
  }
}

function cpuBenchmark(type, config, { batchSize, batches }) {
  const candidates = batchSize * batches
  const stem =
    type === 'multisig' ? config.namespace + '$' + crypto.randomBytes(32).toString('hex') : ''
  const prefix = 'y'.repeat(10)
  let matches = 0
  const started = Date.now()

  for (let i = 0; i < candidates; i++) {
    let key

    if (type === 'touch') {
      const pair = crypto.keyPair()
      key = Hypercore.key({ signers: [{ publicKey: pair.publicKey }] })
    } else {
      const namespace = stem + i.toString(16).padStart(16, '0')
      key = HyperMultisig.getCoreKey(config.publicKeys, namespace, { quorum: config.quorum })
    }

    if (z32.encode(key).startsWith(prefix)) matches++
  }

  const seconds = (Date.now() - started) / 1000

  if (seconds <= 0) throw new Error('Benchmark is below clock resolution; increase batches')

  return {
    backend: 'cpu',
    workers: 1,
    mode: type,
    batchSize,
    candidates,
    seconds,
    candidatesPerSecond: candidates / seconds,
    matches
  }
}
