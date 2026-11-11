'use strict'

// The pear-vanity-gpu command. It always runs under Bare: bin/pear-vanity-gpu.js
// loads it directly in Bare and starts it in a Bare child process from Node.js,
// passing the arguments and working directory through the environment.
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const tty = require('bare-tty')
const Signal = require('bare-signals')
const Hypercore = require('hypercore')
const HyperMultisig = require('hyper-multisig')
const z32 = require('z32')
const findVanityKey = require('../index')
const validation = require('./options')
const createSignal = require('./signal')
const { count, duration, label, where } = require('./format')
const pkg = require('../package.json')

const HELP = `Usage: pear-vanity-gpu <prefix> [options]
       pear-vanity-gpu benchmark [touch|multisig] [benchmark options]

Finds a Hypercore key starting with <prefix>, written in lowercase z32
(ybndrfg8ejkmcpqxot1uwisza345h769). Each extra character takes 32 times longer.

Search:
  -b, --backend NAME    auto (default), cpu, vulkan, opencl or hip
  -w, --workers N       CPU worker threads, 1 to 256
      --batch N         GPU candidates per batch, 64 to 1048576
      --allow-software  allow software GPU drivers (for testing)

Multisig (varies a namespace suffix instead of creating a key pair):
  -m, --multisig        search for a multisig namespace
  -k, --key KEY         signer public key, z32 or hex; repeat for each signer
  -n, --namespace NAME  namespace to add a suffix to
      --quorum N        signatures required (default: a majority)

Output:
  -o, --out FILE        write the key pair to a new FILE readable only by you
      --json            print the result as JSON
  -q, --quiet           no progress or fallback messages
  -h, --help            show this help
  -v, --version         show the version

The secret key is printed to standard output unless --out is given.
Run "pear-vanity-gpu benchmark --help" for benchmark options.`

class UsageError extends Error {}

module.exports = main()

async function main() {
  let args
  let cwd

  try {
    const passed = os.getEnv('PEAR_VANITY_CLI_ARGS')
    args = passed ? JSON.parse(passed) : Bare.argv.slice(2)
    cwd = os.getEnv('PEAR_VANITY_CLI_CWD') || os.cwd()
  } catch {
    return fail(new Error('Invalid arguments from the Node.js launcher'))
  }

  if (args[0] === 'benchmark') {
    const benchmark = require('./benchmark')

    if (args.includes('--help') || args.includes('-h')) return write(benchmark.usage)

    try {
      await benchmark.run(args.slice(1))
    } catch (e) {
      fail(e)
    }

    return
  }

  let options

  try {
    options = parse(args)
  } catch (e) {
    return fail(e)
  }

  if (options.help) return write(HELP)
  if (options.version) return write(pkg.version)

  try {
    await search(options, cwd)
  } catch (e) {
    fail(e)
  }
}

function parse(args) {
  const options = { keys: [], search: {} }
  const positional = []

  for (let i = 0; i < args.length; i++) {
    let arg = args[i]
    let inline

    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1)
      arg = arg.slice(0, arg.indexOf('='))
    }

    const value = () => {
      if (inline !== undefined) return inline
      if (i + 1 >= args.length) throw new UsageError(`${arg} needs a value`)
      return args[++i]
    }
    const integer = () => {
      const text = value()
      const number = Number(text)

      if (!/^\d+$/.test(text) || !Number.isSafeInteger(number)) {
        throw new UsageError(`${arg} must be a whole number`)
      }

      return number
    }
    const flag = () => {
      if (inline !== undefined) throw new UsageError(`${arg} does not take a value`)
      return true
    }

    switch (arg) {
      case '-b':
      case '--backend':
        options.search.backend = value()
        break
      case '-w':
      case '--workers':
        options.search.workers = integer()
        break
      case '--batch':
        options.search.batchSize = integer()
        break
      case '--allow-software':
        options.search.allowSoftware = flag()
        break
      case '-m':
      case '--multisig':
        options.multisig = flag()
        break
      case '-k':
      case '--key':
        options.keys.push(value())
        break
      case '-n':
      case '--namespace':
        options.namespace = value()
        break
      case '--quorum':
        options.quorum = integer()
        break
      case '-o':
      case '--out':
        options.out = value()
        break
      case '--json':
        options.json = flag()
        break
      case '-q':
      case '--quiet':
        options.quiet = flag()
        break
      case '-h':
      case '--help':
        options.help = flag()
        break
      case '-v':
      case '--version':
        options.version = flag()
        break
      default:
        if (arg.startsWith('-') && arg !== '-') throw new UsageError(`Unknown option ${arg}`)
        positional.push(arg)
    }
  }

  if (options.help || options.version) return options

  if (positional.length !== 1) {
    throw new UsageError(
      positional.length ? 'Give exactly one prefix' : 'Missing prefix; see --help'
    )
  }

  options.prefix = positional[0]

  try {
    validation.prefix(options.prefix)
  } catch {
    throw new UsageError(
      `"${options.prefix}" is not a z32 prefix; use only ybndrfg8ejkmcpqxot1uwisza345h769`
    )
  }

  if (options.multisig) {
    if (options.namespace === undefined) throw new UsageError('--multisig needs --namespace')
    if (options.keys.length === 0) throw new UsageError('--multisig needs at least one --key')
  } else if (options.keys.length || options.namespace !== undefined || options.quorum) {
    throw new UsageError('--key, --namespace and --quorum need --multisig')
  }

  return options
}

async function search(options, cwd) {
  const type = options.multisig ? 'multisig' : 'touch'
  const config = options.multisig
    ? validation.multisig({
        publicKeys: options.keys,
        namespace: options.namespace,
        quorum: options.quorum
      })
    : undefined
  const outFile = options.out === undefined ? null : path.resolve(cwd, options.out)
  const expected = 32 ** options.prefix.length
  const signal = createSignal()
  const sigint = new Signal('SIGINT')
  const started = Date.now()
  // The live display needs a terminal on stderr; otherwise print plain lines.
  const display =
    !options.quiet && tty.isTTY(2)
      ? new (require('./tui'))({
          prefix: options.prefix,
          expected,
          stop: () => signal.abort()
        })
      : null
  let latest = null
  let interrupted = false

  // Fail before searching rather than losing a key to an unwritable path.
  if (outFile) {
    if (fs.existsSync(outFile)) throw new Error(`${outFile} already exists`)
    if (!fs.existsSync(path.dirname(outFile))) {
      throw new Error(`Directory ${path.dirname(outFile)} does not exist`)
    }
  }

  // The display reads Ctrl-C as a key in raw mode; SIGINT still arrives when
  // stdin is not a terminal or from outside.
  sigint
    .on('signal', () => {
      // A second Ctrl-C exits at once.
      if (interrupted) Bare.exit(130)
      interrupted = true
      signal.abort()
    })
    .start()

  if (display) {
    display.start().then(() => signal.abort())
  } else if (!options.quiet) {
    status(`Searching for ${options.prefix || '(any)'}, expected ${count(expected)} candidates`)
  }

  let result

  try {
    result = await findVanityKey(options.prefix, type, config, {
      ...options.search,
      signal,
      onFallback: display
        ? (e) => display.fallback(e)
        : options.quiet
          ? undefined
          : (e) => status(`${label(e.backend)} unavailable: ${e.message}`),
      onProgress: (progress) => {
        latest = progress
        if (display) display.progress(progress)
      }
    })
  } catch (e) {
    const stopped = e.code === 'ABORT_ERR'

    if (display) for (const line of await display.end(stopped ? 'stopped' : 'failed')) status(line)
    else if (stopped && !options.quiet) status('Stopped.')

    if (!stopped) throw e

    Bare.exitCode = 130
    return
  } finally {
    sigint.close()
  }

  if (display) {
    for (const line of await display.end('found')) status(line)
  } else if (!options.quiet) {
    const seconds = (Date.now() - started) / 1000
    status(`Found in ${duration(seconds)}${latest ? ' on ' + where(latest) : ''}.`)
  }

  if (type === 'multisig') {
    const key = z32.encode(
      HyperMultisig.getCoreKey(config.publicKeys, result, { quorum: config.quorum })
    )
    const output = { key, namespace: result, quorum: config.quorum }

    if (outFile) save(outFile, output)

    return write(options.json ? JSON.stringify(output) : `key        ${key}\nnamespace  ${result}`)
  }

  const key = z32.encode(Hypercore.key({ signers: [{ publicKey: result.publicKey }] }))
  const publicKey = result.publicKey.toString('hex')

  if (outFile) {
    save(outFile, { key, publicKey, secretKey: result.secretKey.toString('hex') })
    result.secretKey.fill(0)

    return write(
      options.json
        ? JSON.stringify({ key, publicKey, file: outFile })
        : `key         ${key}\npublic key  ${publicKey}\nsecret key  saved to ${outFile}`
    )
  }

  const secretKey = result.secretKey.toString('hex')
  result.secretKey.fill(0)

  write(
    options.json
      ? JSON.stringify({ key, publicKey, secretKey })
      : `key         ${key}\npublic key  ${publicKey}\nsecret key  ${secretKey}`
  )
}

// Creates the file exclusively with owner-only permissions (on POSIX systems).
function save(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

// Result lines go to stdout; everything else goes to stderr.
function write(text) {
  console.log(text)
}

function status(text) {
  console.error(text)
}

function fail(e) {
  console.error(e.message)
  Bare.exitCode = e instanceof UsageError ? 2 : 1
}
