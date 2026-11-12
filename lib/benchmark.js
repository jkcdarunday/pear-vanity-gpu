'use strict'

const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const HyperMultisig = require('hyper-multisig')
const z32 = require('z32')
const { benchmark } = require('../index')

// Fixed-work throughput measurements for `pear-vanity-gpu benchmark` (and
// `npm run benchmark`). Results are printed as JSON, one per backend.
exports.run = async function run({ type, backend, ...options }) {
  const backends =
    backend === 'both'
      ? ['cpu', 'vulkan']
      : backend === 'all'
        ? ['cpu', 'vulkan', 'opencl', 'hip']
        : backend.split(',')

  if (backends.some((name) => !['cpu', 'vulkan', 'opencl', 'hip'].includes(name))) {
    throw new Error('Benchmark backend must be cpu, vulkan, opencl, hip, both, all or a list')
  }
  if (!['touch', 'multisig'].includes(type)) throw new Error('Unknown benchmark type')

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
