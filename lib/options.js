'use strict'

const os = require('bare-os')
const hid = require('hypercore-id-encoding')

exports.backends = ['auto', 'cpu', 'vulkan', 'opencl', 'hip']

exports.prefix = function prefix(start) {
  const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769'

  if (
    typeof start !== 'string' ||
    start.length > 52 ||
    [...start].some((c) => !alphabet.includes(c)) ||
    (start.length === 52 && alphabet.indexOf(start[51]) % 16 !== 0)
  ) {
    throw new Error('Vanity prefix must be a valid z32 prefix of a 32-byte key')
  }
}

exports.validate = function validate(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Vanity options must be an object')
  }

  const backend =
    options.backend === undefined ? (os.getEnv('PEAR_VANITY_BACKEND') ?? 'auto') : options.backend

  if (!exports.backends.includes(backend)) {
    throw new Error('Vanity backend must be auto, cpu, vulkan, opencl or hip')
  }

  if (
    options.workers !== undefined &&
    (!Number.isSafeInteger(options.workers) || options.workers < 1 || options.workers > 256)
  ) {
    throw new Error('Vanity worker count must be between 1 and 256')
  }

  if (options.onFallback !== undefined && typeof options.onFallback !== 'function') {
    throw new TypeError('onFallback must be a function')
  }

  if (options.allowSoftware !== undefined && typeof options.allowSoftware !== 'boolean') {
    throw new TypeError('allowSoftware must be a boolean')
  }

  if (options.addon !== undefined && (typeof options.addon !== 'string' || !options.addon)) {
    throw new TypeError('addon must be a nonempty path string')
  }

  const cache = options.cacheDirectory

  if (
    cache !== undefined &&
    cache !== false &&
    (typeof cache !== 'string' || !cache.startsWith('/') || Buffer.byteLength(cache) > 3072)
  ) {
    throw new TypeError('cacheDirectory must be false or an absolute path')
  }

  const signal = options.signal

  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new TypeError('signal must be an AbortSignal')
  }

  const requested =
    options.batchSize === undefined ? os.getEnv('PEAR_VANITY_VULKAN_BATCH') : options.batchSize

  const batchSize = requested === undefined ? 0 : Number(requested)

  if (
    requested !== undefined &&
    ((typeof requested !== 'number' && typeof requested !== 'string') ||
      !Number.isInteger(batchSize) ||
      batchSize < 64 ||
      batchSize > 1048576)
  ) {
    throw new Error('GPU batch size must be between 64 and 1048576')
  }
  exports.throwIfAborted(signal)

  return { ...options, backend, batchSize: requested === undefined ? undefined : batchSize }
}

exports.multisig = function multisig(config) {
  if (!config || typeof config.namespace !== 'string') {
    throw new Error('Missing multisig namespace')
  }

  if (!Array.isArray(config.publicKeys) || config.publicKeys.length === 0) {
    throw new Error('Multisig publicKeys must be a nonempty array')
  }

  const publicKeys = config.publicKeys.map((key) => Buffer.from(hid.decode(key)))
  const quorum = config.quorum === undefined ? Math.floor(publicKeys.length / 2) + 1 : config.quorum

  if (!Number.isInteger(quorum) || quorum < 1 || quorum > publicKeys.length) {
    throw new Error('Multisig quorum must be between 1 and the signer count')
  }

  return { publicKeys, namespace: config.namespace, quorum }
}

exports.abortError = function abortError() {
  const error = new Error('Vanity search aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'

  return error
}

exports.throwIfAborted = function throwIfAborted(signal) {
  if (signal && signal.aborted) throw exports.abortError()
}
