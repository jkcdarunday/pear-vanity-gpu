'use strict'

// Progress reporting and the command-line tool. CPU only, so it runs anywhere.
const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const subprocess = require('bare-subprocess')
const z32 = require('z32')
const crypto = require('hypercore-crypto')
const findVanityKey = require('..')
const createSignal = require('../lib/signal')

const bin = path.join(__dirname, '..', 'bin', 'pear-vanity-gpu.js')

function run(args) {
  const result = subprocess.spawnSync(os.execPath(), [bin, ...args])

  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  }
}

test('CPU searches report progress with a measured rate', async (t) => {
  const signal = createSignal()
  const reports = []
  const pending = findVanityKey('y'.repeat(40), 'touch', undefined, {
    backend: 'cpu',
    workers: 2,
    signal,
    onProgress: (progress) => reports.push(progress)
  })
  const assertion = t.exception(pending, /aborted/)

  setTimeout(() => signal.abort(), 1500)
  await assertion

  t.ok(reports.length >= 2, 'several reports')

  const last = reports[reports.length - 1]

  t.is(last.backend, 'cpu')
  t.absent('device' in last, 'CPU reports name no device')
  t.ok(last.candidates > 0 && last.candidatesPerSecond > 0 && last.seconds > 0)
  t.ok(
    reports.every((report, i) => i === 0 || report.candidates >= reports[i - 1].candidates),
    'candidate counts never decrease'
  )
  await t.exception.all(
    findVanityKey('p', 'touch', undefined, { onProgress: 1 }),
    /onProgress must be a function/
  )
})

test('the command prints a matching key pair as JSON', (t) => {
  const { status, stdout, stderr } = run(['pe', '-b', 'cpu', '-w', '1', '--json'])
  const result = JSON.parse(stdout)

  t.is(status, 0)
  t.ok(result.key.startsWith('pe'))
  t.is(result.secretKey.length, 128)
  t.is(result.secretKey.slice(64), result.publicKey, 'secret key embeds the public key')
  t.ok(/Found in/.test(stderr), 'status goes to stderr')
})

test('the command writes keys to a new private file', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-vanity-gpu-cli-'))
  const file = path.join(directory, 'key.json')

  try {
    const first = run(['p', '-b', 'cpu', '-w', '1', '-q', '--out', file])
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))

    t.is(first.status, 0)
    t.is(first.stderr, '', '--quiet prints nothing to stderr')
    t.absent(first.stdout.includes(saved.secretKey), 'secret key stays out of stdout')
    t.ok(saved.key.startsWith('p'))

    if (os.platform() !== 'win32') t.is(fs.statSync(file).mode & 0o777, 0o600)

    const second = run(['p', '-b', 'cpu', '--out', file])

    t.is(second.status, 1)
    t.ok(/already exists/.test(second.stderr), 'never overwrites a key file')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the command searches multisig namespaces', (t) => {
  const keys = [crypto.keyPair().publicKey, crypto.keyPair().publicKey]
  const args = ['p', '-b', 'cpu', '-w', '1', '--json', '-m', '-n', 'demo']

  for (const key of keys) args.push('-k', z32.encode(key))

  const { status, stdout } = run(args)
  const result = JSON.parse(stdout)

  t.is(status, 0)
  t.ok(result.key.startsWith('p'))
  t.ok(result.namespace === 'demo' || result.namespace.startsWith('demo$'))
  t.is(result.quorum, 2)
})

test('the command rejects bad input with usage errors', (t) => {
  for (const args of [[], ['Pear'], ['p', '--bogus'], ['p', '-k', 'x'], ['p', '-w', 'two']]) {
    const { status, stdout } = run(args)

    t.is(status, 2, args.join(' ') || '(no arguments)')
    t.is(stdout, '')
  }

  t.ok(/Usage: pear-vanity-gpu <prefix>/.test(run(['--help']).stdout))
  t.is(run(['--version']).stdout.trim(), require('../package.json').version)
})
