'use strict'

const os = require('bare-os')
const validation = require('./options')
const runWorkers = require('./workers')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const HyperMultisig = require('hyper-multisig')
const Verifier = require('hypercore/lib/verifier')
const { manifest: encoding } = require('hypercore/lib/messages')
const { MANIFEST } = require('hypercore/lib/caps')
const { getManifest } = require('hyper-multisig/lib/core')
const z32 = require('z32')

const labels = { vulkan: 'Vulkan', opencl: 'OpenCL', hip: 'HIP' }

exports.backends = Object.keys(labels)

exports.search = async function search(backend, target, type, config, options = {}) {
  const label = backendLabel(backend)

  validation.prefix(target)
  options = validation.validate(options)

  if (type !== 'touch' && type !== 'multisig') throw new Error('Unknown vanity search type')

  if (type === 'multisig') config = validation.multisig(config)

  const { template, offsets, base } = prepare(type, config)
  const result = await tag(
    backend,
    run(backend, options, [
      type,
      target,
      template.toString('hex'),
      Buffer.from(base).toString('hex'),
      offsets.join(' ')
    ])
  )

  if (typeof result !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(result)) {
    throw tagged(backend, new Error(`Invalid ${label} vanity response`))
  }

  if (type === 'touch') {
    if (result.length !== 64) throw tagged(backend, new Error(`Invalid ${label} vanity seed`))

    const seed = Buffer.from(result, 'hex')
    let pair

    try {
      pair = crypto.keyPair(seed)
    } finally {
      seed.fill(0)
    }

    if (
      !z32.encode(Hypercore.key({ signers: [{ publicKey: pair.publicKey }] })).startsWith(target)
    ) {
      pair.secretKey.fill(0)
      throw tagged(backend, new Error(`${label} vanity key failed CPU verification`))
    }

    return pair
  }

  const namespace = Buffer.from(result, 'hex').toString()

  if (
    !namespace.startsWith(base + '$') ||
    !z32
      .encode(HyperMultisig.getCoreKey(config.publicKeys, namespace, { quorum: config.quorum }))
      .startsWith(target)
  ) {
    throw tagged(backend, new Error(`${label} vanity namespace failed CPU verification`))
  }

  return namespace
}

// Fixed-work measurements never return signing material. All runs retain the
// differential GPU checks, including across full batches and partial workgroups.
exports.benchmark = async function benchmark(backend, type, config, options = {}) {
  backendLabel(backend)

  if (type !== 'touch' && type !== 'multisig') throw new Error('Unknown vanity benchmark type')
  options = validation.validate(options)

  if (type === 'multisig') config = validation.multisig(config)

  const batches = options.batches === undefined ? 10 : options.batches

  if (!Number.isInteger(batches) || batches < 1 || batches > 100000) {
    throw new Error('Benchmark batches must be between 1 and 100000')
  }

  const { template, offsets, base } = prepare(type, config)

  return JSON.parse(
    await tag(
      backend,
      run(
        backend,
        options,
        [
          type,
          'y'.repeat(10),
          template.toString('hex'),
          Buffer.from(base).toString('hex'),
          offsets.join(' ')
        ],
        batches
      )
    )
  )
}

// Compiled OpenCL and HIP kernels are cached per user. Entries contain only
// public kernel code; search secrets never reach the compiler.
exports.cacheDirectory = function cacheDirectory(option) {
  if (option === false) return ''
  if (typeof option === 'string') return usable(option)

  const configured = os.getEnv('PEAR_VANITY_CACHE_DIR')

  if (configured !== undefined) return usable(configured)

  let root

  try {
    if (os.platform() === 'darwin') {
      root = os.homedir() + '/Library/Caches'
    } else if (os.platform() === 'win32') {
      root = os.getEnv('LOCALAPPDATA')
    } else {
      const xdg = os.getEnv('XDG_CACHE_HOME')
      root = xdg && xdg.startsWith('/') ? xdg : os.homedir() + '/.cache'
    }
  } catch {
    return ''
  }

  return root ? usable(root + '/pear-vanity-gpu') : ''
}

// Paths that cannot be used disable caching rather than failing the search.
function usable(directory) {
  return directory.startsWith('/') && Buffer.byteLength(directory) <= exports.cacheLimit
    ? directory
    : ''
}

exports.cacheLimit = 3072

function backendLabel(backend) {
  if (!Object.hasOwn(labels, backend)) throw new Error('Unknown GPU backend')

  return labels[backend]
}

function tagged(backend, err) {
  if (err && typeof err === 'object' && err.code !== 'ABORT_ERR' && !err.backend) {
    err.backend = backend
  }

  return err
}

async function tag(backend, promise) {
  try {
    return await promise
  } catch (err) {
    throw tagged(backend, err)
  }
}

// Use the installed Hypercore serializer, including its domain separator. Derive
// patch locations by changing one field at a time rather than freezing its wire format.
function prepare(type, config) {
  const input =
    type === 'touch'
      ? { signers: [{ publicKey: Buffer.alloc(32) }] }
      : getManifest(config.publicKeys, config.namespace, { quorum: config.quorum })

  const manifest = Verifier.createManifest(input)
  const template = encode(manifest)

  if (!crypto.hash(template).equals(Hypercore.key(input))) {
    throw new Error('Unsupported Hypercore manifest encoding')
  }

  const field = type === 'touch' ? 'publicKey' : 'namespace'
  const offsets = manifest.signers.map((signer) => {
    const original = signer[field]
    signer[field] = Buffer.from(original.map((byte) => byte ^ 255))

    const changed = encode(manifest)
    signer[field] = original

    const positions = []

    for (let i = 0; i < template.length; i++) if (changed[i] !== template[i]) positions.push(i)

    if (
      changed.length !== template.length ||
      positions.length !== 32 ||
      positions[31] !== positions[0] + 31
    ) {
      throw new Error('Unsupported Hypercore signer encoding')
    }

    return positions[0]
  })

  const base =
    type === 'touch'
      ? ''
      : config.namespace.includes('$')
        ? config.namespace.split('$').slice(0, -1).join('$')
        : config.namespace

  if (
    template.length > 4096 ||
    Buffer.byteLength(base) > 1983 ||
    offsets.length === 0 ||
    offsets.length > 64
  ) {
    throw new Error('Manifest or namespace exceeds GPU vanity limits')
  }

  return { template, offsets, base }
}

function encode(manifest) {
  const state = { start: 32, end: 32, buffer: null }
  encoding.preencode(state, manifest)
  state.buffer = Buffer.alloc(state.end)
  MANIFEST.copy(state.buffer)
  encoding.encode(state, manifest)

  return state.buffer
}

function run(backend, options, lines, batches = 0) {
  return runWorkers(
    require.resolve('./gpu-worker'),
    [
      {
        backend,
        configuration: lines.join('\n') + '\n',
        addon: options.addon,
        allowSoftware: options.allowSoftware || false,
        batchSize: options.batchSize || 0,
        batches,
        cacheDirectory: exports.cacheDirectory(options.cacheDirectory)
      }
    ],
    options
  )
}
