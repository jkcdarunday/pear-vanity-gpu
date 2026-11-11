'use strict'

// Runs in a Bare child process started by the Node.js entry points (node/). It
// reads one JSON request line from stdin, runs the search or benchmark, and
// writes newline-delimited JSON messages to stdout: fallback events, then one
// result or error. A later {"abort":true} line cancels the request.
const Pipe = require('bare-pipe')

const entries = {
  '.': () => require('../index'),
  vulkan: () => require('./vulkan'),
  opencl: () => require('./opencl'),
  hip: () => require('./hip')
}

const input = new Pipe(0)
const output = new Pipe(1)
const signal = createSignal()
let buffered = ''
let started = false

input.setEncoding('utf8')
input.on('data', (chunk) => {
  buffered += chunk

  for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    receive(JSON.parse(line, revive))
  }
})
// A parent that goes away cancels the search rather than leaving it running.
input.on('end', () => signal.abort())
input.on('error', () => signal.abort())

function receive(message) {
  if (message.abort) return signal.abort()
  if (started) return
  started = true
  Promise.resolve(message)
    .then(run)
    .then(
      (result) => finish({ result: encodeResult(result) }),
      (err) => finish({ error: encodeError(err) })
    )
}

function run({ entry, method, args }) {
  if (!Object.hasOwn(entries, entry) || (method !== 'search' && method !== 'benchmark')) {
    throw new Error('Unknown vanity host request')
  }

  const api = entries[entry]()
  const [a, b, c, d] = args

  if (method === 'benchmark') return api.benchmark(a, b, withHostOptions(c))

  return api(a, b, c, withHostOptions(d))
}

function withHostOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options

  const { hasFallback, hasSignal, ...rest } = options

  if (hasFallback) {
    rest.onFallback = (err) => send({ event: 'fallback', error: encodeError(err) })
  }

  if (hasSignal) rest.signal = signal

  return rest
}

function send(message) {
  output.write(JSON.stringify(message) + '\n')
}

function finish(message) {
  output.end(JSON.stringify(message) + '\n')
  input.destroy()
}

function encodeResult(result) {
  if (result && typeof result === 'object' && result.secretKey && result.publicKey) {
    const encoded = {
      keyPair: {
        publicKey: Buffer.from(result.publicKey).toString('hex'),
        secretKey: Buffer.from(result.secretKey).toString('hex')
      }
    }
    result.secretKey.fill(0)

    return encoded
  }

  return { value: result }
}

function encodeError(err) {
  if (!err || typeof err !== 'object') return { message: String(err) }

  return {
    name: err.name,
    message: err.message,
    code: err.code,
    backend: err.backend
  }
}

// Buffers cross the pipe as { __buffer: hex }.
function revive(key, value) {
  return value && typeof value === 'object' && typeof value.__buffer === 'string'
    ? Buffer.from(value.__buffer, 'hex')
    : value
}

// Bare has no AbortController, so the host supplies the minimal signal shape
// that lib/options.js accepts.
function createSignal() {
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
