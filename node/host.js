'use strict'

// Node.js has no Bare APIs, so Node entry points run the search in a Bare child
// process (lib/host.js) and exchange newline-delimited JSON over its stdio.
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

const INSTALL_HINT =
  'pear-vanity-gpu runs on the Bare runtime, which was not found. Install it next to ' +
  'this package with `npm install bare-runtime`, install it globally with ' +
  '`npm install -g bare`, set PEAR_VANITY_BARE to a Bare executable, or run your ' +
  'application with `bare` or inside Pear instead of Node.js.'

// Order: PEAR_VANITY_BARE, the bare-runtime package, then `bare` on PATH.
function findBare() {
  const configured = process.env.PEAR_VANITY_BARE

  if (configured) return { command: configured, shell: false }

  try {
    const binary = require(require.resolve('bare-runtime', { paths: [process.cwd(), root] }))()

    try {
      fs.accessSync(binary, fs.constants.X_OK)
    } catch {
      fs.chmodSync(binary, 0o755)
    }

    return { command: binary, shell: false }
  } catch {}

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : ['']

  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue

    for (const extension of extensions) {
      const candidate = path.join(directory, 'bare' + extension.toLowerCase())

      try {
        if (!fs.statSync(candidate).isFile()) continue
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
      } catch {
        continue
      }

      // npm's global `bare` is a .cmd shim on Windows, which needs a shell.
      return { command: candidate, shell: /\.(cmd|bat)$/i.test(candidate) }
    }
  }

  return null
}

const required = require('../package.json').engines.bare.replace(/^>=\s*/, '')
const checked = new Map()

// Older Bare releases fail inside module resolution with an unrelated-looking
// engine error, so check the version once per executable and explain it.
function checkVersion(bare) {
  if (checked.has(bare.command)) return checked.get(bare.command)

  const result = childProcess.spawnSync(
    bare.shell ? `"${bare.command}"` : bare.command,
    ['--version'],
    { shell: bare.shell, encoding: 'utf8', timeout: 15000, windowsHide: true }
  )
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(result.stdout || ''))
  let err = null

  if (result.error || !match) {
    err = new Error(
      `Could not run Bare at ${bare.command}` +
        (result.error ? `: ${result.error.message}` : '') +
        '. ' +
        INSTALL_HINT.replace(', which was not found', '')
    )
    err.code = 'ERR_BARE_NOT_FOUND'
  } else if (compare(match.slice(1).map(Number), required.split('.').map(Number)) < 0) {
    err = new Error(
      `pear-vanity-gpu needs Bare ${required} or newer, but ${bare.command} is Bare ` +
        `${match.slice(1).join('.')}. Upgrade it with \`npm install -g bare\`, or install a ` +
        'newer runtime next to this package with `npm install bare-runtime`.'
    )
    err.code = 'ERR_BARE_VERSION'
  }

  checked.set(bare.command, err)

  return err
}

function compare(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]

  return 0
}

exports.findBare = findBare
exports.INSTALL_HINT = INSTALL_HINT

exports.call = function call(entry, method, args, options) {
  return new Promise((resolve, reject) => {
    const bare = findBare()

    if (!bare) {
      const err = new Error(INSTALL_HINT)
      err.code = 'ERR_BARE_NOT_FOUND'
      throw err
    }

    const unusable = checkVersion(bare)

    if (unusable) throw unusable

    const { signal, onFallback } = options && typeof options === 'object' ? options : {}

    if (onFallback !== undefined && typeof onFallback !== 'function') {
      throw new TypeError('onFallback must be a function')
    }

    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    ) {
      throw new TypeError('signal must be an AbortSignal')
    }

    if (signal && signal.aborted) throw abortError()

    // The host script is passed relative to the package directory, so no path
    // ever needs shell quoting when a Windows .cmd shim is used.
    const child = childProcess.spawn(
      bare.shell ? `"${bare.command}"` : bare.command,
      ['lib/host.js'],
      {
        cwd: root,
        shell: bare.shell,
        // Bare's pipes need overlapped handles on Windows; with plain pipes
        // the child's stdout writes never complete.
        stdio: ['overlapped', 'overlapped', 'inherit'],
        windowsHide: true
      }
    )

    let buffered = ''
    let settled = false
    let reply = null

    const onAbort = () => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ abort: true }) + '\n')
    }

    const settle = (err, value) => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve(value)
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        const missing = new Error(INSTALL_HINT)
        missing.code = 'ERR_BARE_NOT_FOUND'
        return settle(missing)
      }
      settle(err)
    })

    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk

      for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        let message

        try {
          message = JSON.parse(line)
        } catch {
          continue
        }

        if (message.event === 'fallback') {
          if (onFallback) onFallback(decodeError(message.error))
        } else if (message.error || message.result) {
          reply = message
        }
      }
    })

    // Resolve only after the Bare process, and with it every GPU context, has exited.
    child.on('close', (code, signalName) => {
      if (reply && reply.error) return settle(decodeError(reply.error))
      if (reply) return settle(null, decodeResult(reply.result))
      settle(
        new Error(`Bare vanity process exited without a result (${signalName || 'code ' + code})`)
      )
    })

    const request = {
      entry,
      method,
      args: args.map((arg, i) =>
        i === args.length - 1 ? hostOptions(arg, Boolean(onFallback), Boolean(signal)) : arg
      )
    }

    child.stdin.write(JSON.stringify(request, replace) + '\n')
  })
}

function hostOptions(options, hasFallback, hasSignal) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options

  const { signal, onFallback, ...rest } = options

  return { ...rest, hasFallback, hasSignal }
}

// Buffers and typed arrays (such as multisig public keys) cross as hex.
function replace(key, value) {
  const original = this[key]

  return original instanceof Uint8Array
    ? { __buffer: Buffer.from(original).toString('hex') }
    : value
}

function decodeResult(result) {
  if (result.keyPair) {
    return {
      publicKey: Buffer.from(result.keyPair.publicKey, 'hex'),
      secretKey: Buffer.from(result.keyPair.secretKey, 'hex')
    }
  }

  return result.value
}

function decodeError(error) {
  const Constructor = error.name === 'TypeError' ? TypeError : Error
  const err = new Constructor(error.message)

  if (error.name && error.name !== 'Error' && error.name !== 'TypeError') err.name = error.name
  if (error.code !== undefined) err.code = error.code
  if (error.backend !== undefined) err.backend = error.backend

  return err
}

function abortError() {
  const err = new Error('Vanity search aborted')
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'

  return err
}
