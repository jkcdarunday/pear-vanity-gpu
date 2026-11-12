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
    // Stop after a few reports rather than after a fixed time, for slow machines.
    onProgress: (progress) => {
      if (reports.push(progress) === 3) signal.abort()
    }
  })

  await t.exception(pending, /aborted/)

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

  t.ok(/pear-vanity-gpu \[flags\] <prefix>/.test(run(['--help']).stdout))
  t.ok(/pear-vanity-gpu benchmark \[flags\] \[type\]/.test(run(['benchmark', '-h']).stdout))
  t.is(run(['benchmark', 'nope']).status, 2)
  t.is(run(['--version']).stdout.trim(), require('../package.json').version)
})

test('the benchmark command measures the CPU', (t) => {
  const { status, stdout } = run([
    'benchmark',
    'touch',
    '-b',
    'cpu',
    '--batch',
    '64',
    '--batches',
    '2'
  ])
  const result = JSON.parse(stdout)

  t.is(status, 0)
  t.is(result.backend, 'cpu')
  t.is(result.candidates, 128)
})

test('non-z32 prefixes get lookalike z32 suggestions', (t) => {
  const suggest = require('../lib/suggest')

  t.alike(suggest('holepunch').suggestions, ['ho1epunch', 'hoiepunch'])
  t.alike(suggest('Pear'), { capitals: true, missing: [], dropped: [], suggestions: ['pear'] })
  t.alike(suggest('keet-v2'), {
    capitals: false,
    missing: ['-', 'v', '2'],
    dropped: ['-'],
    suggestions: ['keetuz', 'keetyz']
  })
  t.is(suggest('HELLO0').suggestions[0], 'he11oo')
  t.alike(suggest('!!!').suggestions, [], 'nothing to suggest')

  const { status, stdout, stderr } = run(['holepunch'])

  t.is(status, 2)
  t.is(stdout, '')
  t.ok(stderr.includes('"l" is not in the z32 alphabet'))
  t.ok(stderr.includes('Try ho1epunch or hoiepunch'))
})

test('the prefix menu picks a suggestion or quits', (t) => {
  const { KeyMsg } = require('bare-tui')
  const { PrefixModel } = require('../lib/tui')
  const press = (name) => new KeyMsg({ name, ctrl: false, meta: false, shift: false })
  const menu = () =>
    new PrefixModel({ problem: '"pl" is not z32', hint: '', suggestions: ['p1', 'pi'] })

  const enter = menu()
  enter.update(press('down'))
  enter.update(press('return'))
  t.is(enter.choice, 'pi', 'arrow keys then enter')

  const number = menu()
  number.update(press('2'))
  t.is(number.choice, 'pi', 'number key')

  const first = menu()
  first.update(press('return'))
  t.is(first.choice, 'p1', 'enter takes the first suggestion')

  const quitRow = menu()
  quitRow.update(press('down'))
  quitRow.update(press('down'))
  quitRow.update(press('return'))
  t.is(quitRow.choice, null, 'the quit row quits')

  const q = menu()
  q.update(press('q'))
  t.is(q.choice, null, 'q quits')
  t.ok(q.view().includes('Search for a z32 spelling instead?'))
})
