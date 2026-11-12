'use strict'

// The pear-vanity-gpu command. It always runs under Bare: bin/pear-vanity-gpu.js
// calls it directly in Bare and is started in a Bare child process from Node.js,
// which passes the arguments and working directory through the environment.
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
const suggest = require('./suggest')
const { count, duration, label, where } = require('./format')
const pkg = require('../package.json')
const { command, flag, arg, summary, description, footer, bail } = require('paparam')

const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'

class UsageError extends Error {}

module.exports = async function main(args, cwd = os.getEnv('PEAR_VANITY_CLI_CWD') || os.cwd()) {
  if (args === undefined) {
    try {
      const passed = os.getEnv('PEAR_VANITY_CLI_ARGS')
      args = passed ? JSON.parse(passed) : Bare.argv.slice(2)
    } catch {
      return fail(new Error('Invalid arguments from the Node.js launcher'))
    }
  }

  try {
    // paparam cannot mix a required positional argument with subcommands, so
    // the first word picks between the two commands.
    if (args[0] === 'benchmark') {
      const options = parse(benchmarkCommand(), args.slice(1))
      if (options) await require('./benchmark').run(benchmarkOptions(options))
    } else {
      const options = parse(searchCommand(), args)
      if (options && options.flags.version) write(pkg.version)
      else if (options) await search(searchOptions(options), cwd)
    }
  } catch (e) {
    fail(e)
  }
}

function searchCommand() {
  return command(
    'pear-vanity-gpu',
    summary('Find a Hypercore key that starts with a chosen prefix'),
    description(
      `Prefixes use lowercase z32: ${ALPHABET}.\n` +
        'Each extra character makes the search 32 times longer.\n' +
        'The secret key is printed on standard output unless --out is given.'
    ),
    arg('<prefix>', 'start of the Hypercore key, in lowercase z32'),
    flag('--backend|-b <name>', 'auto (default), cpu, vulkan, opencl or hip'),
    flag('--workers|-w <n>', 'CPU worker threads, 1 to 256'),
    flag('--batch <n>', 'GPU candidates per batch, 64 to 1048576'),
    flag('--allow-software', 'allow software GPU drivers (for testing)'),
    flag('--multisig|-m', 'search for a multisig namespace suffix instead of a key pair'),
    flag('--key|-k <key>', 'multisig signer public key, z32 or hex; repeat per signer').multiple(),
    flag('--namespace|-n <name>', 'multisig namespace to add a suffix to'),
    flag('--quorum <n>', 'multisig signatures required (default: a majority)'),
    flag('--out|-o <file>', 'write the key pair to a new file readable only by you'),
    flag('--json', 'print the result as JSON'),
    flag('--quiet|-q', 'no progress or fallback messages'),
    flag('--version|-v', 'show the version'),
    footer('Run "pear-vanity-gpu benchmark --help" to measure throughput.'),
    onBail()
  )
}

function benchmarkCommand() {
  return command(
    'pear-vanity-gpu benchmark',
    summary('Measure fixed-work throughput and print JSON per backend'),
    arg('[type]', 'touch (default) or multisig'),
    flag(
      '--backend|-b <names>',
      'cpu, vulkan (default), opencl, hip, both, all or a comma-separated list'
    ),
    flag('--batch <n>', 'candidates per batch, 64 to 1048576 (default 65536)'),
    flag('--batches <n>', 'batches to run, 1 to 100000 (default 10)'),
    flag('--allow-software', 'allow software GPU drivers (for testing)'),
    onBail()
  )
}

// Parse errors become one-line usage errors (exit code 2) instead of paparam's
// default thrown Bail.
function onBail() {
  return bail((b) => {
    throw new UsageError(bailMessage(b))
  })
}

function bailMessage(b) {
  const option = b.flag ? (b.flag.name.length === 1 ? '-' : '--') + b.flag.name : ''

  switch (b.reason) {
    case 'UNKNOWN_FLAG':
      return `Unknown option ${option}; see --help`
    case 'INVALID_FLAG':
      return `${option} needs a value`
    case 'MISSING_ARG':
      return `Missing ${b.arg.value}; see --help`
    case 'UNKNOWN_ARG':
      return `Unexpected argument ${b.arg.value}; see --help`
    default:
      return b.err ? b.err.message : String(b.reason)
  }
}

// Returns the parsed command, or null after printing help.
function parse(cmd, args) {
  return cmd.parse(args, { run: false })
}

function integer(flags, name, label = '--' + name) {
  const text = flags[name]

  if (text === undefined) return undefined
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new UsageError(`${label} must be a whole number`)
  }

  return Number(text)
}

function searchOptions({ args, flags }) {
  const prefix = args.prefix

  try {
    validation.prefix(prefix)
  } catch {
    throw new UsageError(prefixMessage(prefix))
  }

  const keys = flags.key || []
  const options = {
    prefix,
    keys,
    namespace: flags.namespace,
    quorum: integer(flags, 'quorum'),
    multisig: flags.multisig,
    out: flags.out,
    json: flags.json,
    quiet: flags.quiet,
    search: {}
  }

  if (flags.backend !== undefined) options.search.backend = flags.backend
  if (flags.workers !== undefined) options.search.workers = integer(flags, 'workers')
  if (flags.batch !== undefined) options.search.batchSize = integer(flags, 'batch')
  if (flags.allowSoftware) options.search.allowSoftware = true

  if (options.multisig) {
    if (options.namespace === undefined) throw new UsageError('--multisig needs --namespace')
    if (keys.length === 0) throw new UsageError('--multisig needs at least one --key')
  } else if (keys.length || options.namespace !== undefined || options.quorum !== undefined) {
    throw new UsageError('--key, --namespace and --quorum need --multisig')
  }

  return options
}

function prefixMessage(prefix) {
  if ([...prefix].length > 52) return `"${prefix}" is longer than a key (52 z32 characters)`

  const { capitals, missing, dropped, suggestions } = suggest(prefix)
  const quoted = (chars) => chars.map((c) => `"${c}"`).join(', ')
  const problems = []

  if (capitals) problems.push('z32 is lowercase')
  if (missing.length) {
    problems.push(
      `${quoted(missing)} ${missing.length === 1 ? 'is' : 'are'} not in the z32 alphabet (${ALPHABET})`
    )
  }

  let message = `"${prefix}" is not z32: ${problems.join(', and ')}`

  if (suggestions.length) {
    message += `\nTry ${suggestions.join(' or ')}`
    if (dropped.length) message += ` (without ${quoted(dropped)})`
  }

  return message
}

function benchmarkOptions({ args, flags }) {
  const type = args.type || 'touch'

  if (type !== 'touch' && type !== 'multisig') {
    throw new UsageError(`Benchmark type must be touch or multisig, not "${type}"`)
  }

  return {
    type,
    backend: flags.backend || 'vulkan',
    batchSize: integer(flags, 'batch') ?? 65536,
    batches: integer(flags, 'batches') ?? 10,
    allowSoftware: Boolean(flags.allowSoftware)
  }
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
