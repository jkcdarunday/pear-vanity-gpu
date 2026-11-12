'use strict'

// Runs under Node.js (npm run test:node). The Node entry points start a Bare
// child process; the bare-runtime dev dependency provides it here.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const childProcess = require('node:child_process')

const findVanityKey = require('../node/index.js')
const hip = require('../node/hip.js')

const z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'

test('CPU touch search returns Node buffers for a matching signing key', async () => {
  const pair = await findVanityKey('p', 'touch', undefined, { backend: 'cpu', workers: 2 })

  assert.ok(Buffer.isBuffer(pair.publicKey) && Buffer.isBuffer(pair.secretKey))
  assert.strictEqual(pair.publicKey.length, 32)
  assert.strictEqual(pair.secretKey.length, 64)
  // libsodium secret keys end with the public key.
  assert.ok(pair.secretKey.subarray(32).equals(pair.publicKey))
})

test('multisig accepts buffer public keys and returns a suffixed namespace', async () => {
  const keys = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)]
  const namespace = await findVanityKey(
    'pe',
    'multisig',
    { publicKeys: keys, namespace: 'demo' },
    { backend: 'cpu', workers: 2 }
  )

  assert.ok(namespace === 'demo' || namespace.startsWith('demo$'))
})

test('fallback callbacks and errors cross the process boundary', async () => {
  const fallbacks = []
  const pair = await findVanityKey('', 'touch', undefined, {
    backend: 'auto',
    workers: 1,
    addon: path.join(os.tmpdir(), 'missing-pear-vanity-gpu-addon'),
    onFallback: (err) => fallbacks.push(err.backend)
  })

  assert.deepStrictEqual(fallbacks, ['hip', 'opencl', 'vulkan'])
  assert.strictEqual(pair.publicKey.length, 32)

  await assert.rejects(findVanityKey('!', 'touch'), /valid z32 prefix/)
  await assert.rejects(findVanityKey('p', 'touch', undefined, null), TypeError)
  await assert.rejects(findVanityKey('p', 'touch', undefined, { onFallback: 1 }), TypeError)
  await assert.rejects(hip('p'), /Unknown vanity search type/)
  await assert.rejects(findVanityKey.benchmark('touch', undefined, { backend: 'cpu' }), /backend/)
})

test('aborting stops the Bare process with an AbortError', async () => {
  const controller = new AbortController()
  const pending = findVanityKey(z32.repeat(2).slice(0, 12), 'touch', undefined, {
    backend: 'cpu',
    workers: 1,
    signal: controller.signal
  })

  setTimeout(() => controller.abort(), 200)
  await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' })

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(findVanityKey('p', 'touch', undefined, { signal: aborted.signal }), {
    code: 'ABORT_ERR'
  })
})

test('a missing or outdated Bare explains how to install one', () => {
  const script = `
    require(${JSON.stringify(require.resolve('../node/index.js'))})('p')
      .then(() => process.exit(2), (err) => { console.log(err.code); process.exit(0) })
  `
  const run = (bare) =>
    childProcess
      .execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, PEAR_VANITY_BARE: bare },
        encoding: 'utf8'
      })
      .trim()

  assert.strictEqual(run(path.join(os.tmpdir(), 'no-such-bare-executable')), 'ERR_BARE_NOT_FOUND')

  if (process.platform !== 'win32') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-vanity-gpu-bare-'))
    const old = path.join(directory, 'bare')
    fs.writeFileSync(old, '#!/bin/sh\necho v1.0.0\n', { mode: 0o755 })

    try {
      assert.strictEqual(run(old), 'ERR_BARE_VERSION')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('progress reports cross the process boundary', async () => {
  const controller = new AbortController()
  const reports = []
  const pending = findVanityKey(z32.repeat(2).slice(0, 12), 'touch', undefined, {
    backend: 'cpu',
    workers: 1,
    signal: controller.signal,
    // Slow CI machines take a while to start Bare and its workers, so stop
    // after a few reports rather than after a fixed time.
    onProgress: (progress) => {
      if (reports.push(progress) === 3) controller.abort()
    }
  })

  await assert.rejects(pending, { code: 'ABORT_ERR' })

  assert.ok(reports.length >= 2)
  assert.strictEqual(reports[0].backend, 'cpu')
  assert.ok(reports.at(-1).candidates > 0 && reports.at(-1).candidatesPerSecond > 0)
  await assert.rejects(findVanityKey('p', 'touch', undefined, { onProgress: 1 }), TypeError)
})

test('the command runs from Node.js through Bare', () => {
  const bin = path.join(__dirname, '..', 'bin', 'pear-vanity-gpu.js')
  const result = childProcess.spawnSync(
    process.execPath,
    [bin, 'pe', '--backend=cpu', '--workers=1', '--json'],
    { cwd: os.tmpdir(), encoding: 'utf8' }
  )
  const pair = JSON.parse(result.stdout)

  assert.strictEqual(result.status, 0)
  assert.ok(pair.key.startsWith('pe'))
  assert.strictEqual(pair.secretKey.length, 128)

  const usage = childProcess.spawnSync(process.execPath, [bin, 'Not z32'], { encoding: 'utf8' })

  assert.strictEqual(usage.status, 2)
  assert.match(usage.stderr, /is not z32/)
})
