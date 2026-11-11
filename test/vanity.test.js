'use strict'

const test = require('brittle')
const z32 = require('z32')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const HyperMultisig = require('hyper-multisig')
const hid = require('hypercore-id-encoding')
const findVanityKey = require('..')

function pearKey(publicKey) {
  return z32.encode(Hypercore.key({ signers: [{ publicKey }] }))
}

function generateMultisigConfig({ avoid = [] } = {}) {
  let config
  do {
    config = {
      publicKeys: Array.from({ length: 3 }, () => crypto.keyPair().publicKey),
      namespace: 'test-namespace',
      quorum: 2
    }
  } while (avoid.some((prefix) => multisigKey(config.namespace, config).startsWith(prefix)))

  return config
}

function multisigKey(namespace, config) {
  return hid.normalize(
    HyperMultisig.getCoreKey(config.publicKeys, namespace, { quorum: config.quorum })
  )
}

test('touch vanity key should start with given two-char prefix', async ({ plan, ok }) => {
  plan(3)
  {
    const prefix = 'pe'
    const keyPair = await findVanityKey(prefix)
    const z = pearKey(keyPair.publicKey)
    ok(z.startsWith(prefix), `z32 key starts with '${prefix}'`)
  }

  {
    const prefix = 'ea'
    const keyPair = await findVanityKey(prefix)
    const z = pearKey(keyPair.publicKey)
    ok(z.startsWith(prefix), `z32 key starts with '${prefix}'`)
  }

  {
    const prefix = 'rs'
    const keyPair = await findVanityKey(prefix)
    const z = pearKey(keyPair.publicKey)
    ok(z.startsWith(prefix), `z32 key starts with '${prefix}'`)
  }
})

test('repeated calls to touch should return different keys', async ({ plan, not }) => {
  plan(2)
  const prefix = 'cd'
  const keyPair1 = await findVanityKey(prefix)
  const keyPair2 = await findVanityKey(prefix)

  not(keyPair1.publicKey.toString('hex'), keyPair2.publicKey.toString('hex'), 'publicKeys differ')
  not(keyPair1.secretKey.toString('hex'), keyPair2.secretKey.toString('hex'), 'secretKeys differ')
})

test('multisig vanity key should start with given two-char prefix', async ({ plan, ok }) => {
  plan(3)
  const config = generateMultisigConfig({ avoid: ['pe', 'ea', 'rs'] })

  {
    const prefix = 'pe'
    const namespace = await findVanityKey(prefix, 'multisig', config)
    ok(multisigKey(namespace, config).startsWith(prefix), `multisig key starts with '${prefix}'`)
  }

  {
    const prefix = 'ea'
    const namespace = await findVanityKey(prefix, 'multisig', config)
    ok(multisigKey(namespace, config).startsWith(prefix), `multisig key starts with '${prefix}'`)
  }

  {
    const prefix = 'rs'
    const namespace = await findVanityKey(prefix, 'multisig', config)
    ok(multisigKey(namespace, config).startsWith(prefix), `multisig key starts with '${prefix}'`)
  }
})

test('repeated multisig vanity calls should return different namespaces', async ({ plan, not }) => {
  plan(1)
  const prefix = 'ab'
  const config = generateMultisigConfig({ avoid: [prefix] })

  const namespace1 = await findVanityKey(prefix, 'multisig', config)
  const namespace2 = await findVanityKey(prefix, 'multisig', config)

  not(namespace1, namespace2, 'namespaces should differ between calls')
})

test('multisig vanity should retain namespace if already matching', async ({ plan, is }) => {
  plan(1)
  const prefix = 'pe'
  const config = generateMultisigConfig({ avoid: [prefix] })

  const namespace1 = await findVanityKey(prefix, 'multisig', config)
  config.namespace = namespace1
  const namespace2 = await findVanityKey(prefix, 'multisig', config)

  is(namespace1, namespace2, 'namespaces should remain the same')
})

test('vanity rejects impossible prefixes and invalid options', async (t) => {
  for (const prefix of ['A', '0', 'é', 'y'.repeat(53), 'y'.repeat(51) + 'b', 123]) {
    await t.exception(findVanityKey(prefix), /valid z32 prefix/)
  }
  await t.exception(findVanityKey('p', 'unknown'), /Unknown vanity search type/)
  await t.exception(findVanityKey('p', 'touch', undefined, { backend: 'cuda' }), /backend/)
  await t.exception(
    findVanityKey('p', 'touch', undefined, { backend: 'cpu', workers: 0 }),
    /worker count/
  )
  await t.exception(findVanityKey('p', 'multisig'), /Missing multisig namespace/)
})

test('Vulkan can be required or fall back to CPU when unavailable', async (t) => {
  const options = { backend: 'vulkan', addon: '/missing-pear-vanity-gpu-vulkan', workers: 1 }
  await t.exception(findVanityKey('p', 'touch', undefined, options))
  let fallback = null
  const pair = await findVanityKey('p', 'touch', undefined, {
    ...options,
    backend: 'auto',
    onFallback: (err) => {
      fallback = err
    }
  })
  t.ok(fallback instanceof Error)
  t.ok(pearKey(pair.publicKey).startsWith('p'))
  const message = Buffer.from('vanity signing test')
  t.ok(crypto.verify(message, crypto.sign(message, pair.secretKey), pair.publicKey))
})

test('matching multisig namespace requires no GPU even in Vulkan mode', async (t) => {
  const config = generateMultisigConfig()
  const prefix = multisigKey(config.namespace, config).slice(0, 3)
  const namespace = await findVanityKey(prefix, 'multisig', config, {
    backend: 'vulkan',
    addon: '/missing-pear-vanity-gpu-vulkan'
  })
  t.is(namespace, config.namespace)
})

test('invalid options fail before backend selection or fallback', async (t) => {
  for (const options of [null, false, [], { signal: {} }, { onFallback: true }]) {
    await t.exception.all(findVanityKey('', 'touch', undefined, options))
  }

  for (const options of [
    { backend: '' },
    { backend: null },
    { workers: 257 },
    { workers: 1.5 },
    { allowSoftware: 'false' },
    { batchSize: true },
    { batchSize: null },
    { batchSize: 63 },
    { batchSize: 1048577 }
  ]) {
    let fallback = false

    await t.exception.all(
      findVanityKey('', 'touch', undefined, {
        ...options,
        onFallback: () => {
          fallback = true
        }
      })
    )

    t.absent(fallback, 'invalid options never start CPU fallback')
  }
})

test('multisig rejects invalid signer sets and quorums', async (t) => {
  const config = generateMultisigConfig()

  for (const publicKeys of [[], null, [Buffer.alloc(31)], ['invalid']]) {
    await t.exception(findVanityKey('', 'multisig', { ...config, publicKeys }))
  }

  for (const quorum of [0, -1, 1.5, 4, '2', null]) {
    await t.exception(findVanityKey('', 'multisig', { ...config, quorum }), /quorum/)
  }
})

test('direct Vulkan API validates prefixes and benchmark counts before loading an addon', async (t) => {
  const vulkan = require('../lib/vulkan')

  await t.exception(vulkan('invalid', 'touch'), /valid z32 prefix/)
  await t.exception(vulkan('p', 'unknown'), /search type/)

  for (const batches of [0, -1, 1.5, 100001, '2']) {
    await t.exception(vulkan.benchmark('touch', undefined, { batches }), /batches/)
  }
})

// Bare has no global AbortController. Exercise its compatible signal interface
// without requiring a controller implementation in the library.
function cancellation() {
  const listeners = new Set()
  const signal = {
    aborted: false,
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener)
  }

  return {
    signal,
    listeners,
    abort() {
      signal.aborted = true

      for (const listener of listeners) listener()
    }
  }
}

test('CPU searches can be aborted and release their listeners', async (t) => {
  const controller = cancellation()
  const pending = findVanityKey('y'.repeat(40), 'touch', undefined, {
    backend: 'cpu',
    workers: 2,
    signal: controller.signal
  })
  const assertion = t.exception(pending, /aborted/)

  setTimeout(() => controller.abort(), 20)
  await assertion

  t.is(controller.listeners.size, 0)
  await t.exception(findVanityKey('', 'touch', undefined, { signal: controller.signal }), /aborted/)

  const pair = await findVanityKey('', 'touch', undefined, { backend: 'cpu', workers: 1 })
  t.is(pair.publicKey.length, 32, 'subsequent searches still work')
})

test('Vulkan cancellation never triggers CPU fallback', async (t) => {
  const controller = cancellation()
  let fallback = false
  const pending = findVanityKey('y'.repeat(40), 'touch', undefined, {
    signal: controller.signal,
    onFallback: () => {
      fallback = true
    }
  })
  const assertion = t.exception(pending, /aborted/)

  controller.abort()
  await assertion

  t.absent(fallback)
  t.is(controller.listeners.size, 0)
})

const os = require('bare-os')
const fs = require('bare-fs')

// GPU suites are opt-in per backend. Software adapters (llvmpipe, PoCL) are only
// selected when the matching *_SOFTWARE variable is set.
const gpuBackends = [
  ['vulkan', 'Vulkan'],
  ['opencl', 'OpenCL'],
  ['hip', 'HIP']
].map(([backend, label]) => {
  const name = backend.toUpperCase()

  return {
    backend,
    label,
    enabled: os.getEnv('PEAR_TEST_' + name) === '1',
    options: {
      backend,
      allowSoftware: os.getEnv('PEAR_TEST_' + name + '_SOFTWARE') === '1'
    }
  }
})

test('every GPU backend failure is reported before automatic CPU fallback', async (t) => {
  const failures = []
  const config = generateMultisigConfig({ avoid: ['p'] })

  const pair = await findVanityKey('p', 'touch', undefined, {
    addon: '/missing-pear-vanity-gpu-gpu',
    workers: 1,
    onFallback: (err) => failures.push(err.backend)
  })
  t.alike(failures, ['hip', 'opencl', 'vulkan'], 'touch tries HIP, OpenCL, then Vulkan')
  t.ok(pearKey(pair.publicKey).startsWith('p'))

  failures.length = 0
  const namespace = await findVanityKey('p', 'multisig', config, {
    addon: '/missing-pear-vanity-gpu-gpu',
    workers: 1,
    onFallback: (err) => failures.push(err.backend)
  })
  t.alike(failures, ['opencl', 'hip', 'vulkan'], 'multisig tries OpenCL, HIP, then Vulkan')
  t.ok(multisigKey(namespace, config).startsWith('p'))

  for (const backend of ['opencl', 'hip']) {
    await t.exception(
      findVanityKey('p', 'touch', undefined, { backend, addon: '/missing-pear-vanity-gpu-gpu' })
    )
  }
})

test('benchmark and cache options are validated before loading an addon', async (t) => {
  for (const backend of ['auto', 'cpu', 'cuda']) {
    await t.exception(findVanityKey.benchmark('touch', undefined, { backend }), /backend/)
  }

  for (const cacheDirectory of ['', 'relative/path', true, 0, null]) {
    await t.exception.all(
      findVanityKey('', 'touch', undefined, { backend: 'cpu', cacheDirectory }),
      /cacheDirectory/
    )
  }

  const gpu = require('../lib/gpu')
  t.is(gpu.cacheDirectory(false), '')
  if (os.platform() === 'win32') {
    t.is(gpu.cacheDirectory('/explicit/cache'), '', 'Windows never caches kernels')
    t.is(gpu.cacheDirectory(), '', 'Windows never caches kernels')
  } else {
    t.is(gpu.cacheDirectory('/explicit/cache'), '/explicit/cache')
    t.ok(gpu.cacheDirectory().endsWith('pear-vanity-gpu'))
  }
  t.is(gpu.cacheDirectory('/' + 'a'.repeat(gpu.cacheLimit)), '', 'oversized paths disable caching')
})

for (const { backend, label, enabled, options: gpuOptions } of gpuBackends) {
  const skip = !enabled

  test(`${label} limits fall back to CPU only in auto mode`, { skip }, async (t) => {
    const config = generateMultisigConfig()
    config.namespace = 'n'.repeat(1984)
    const prefix = multisigKey(config.namespace, config).startsWith('p') ? 'e' : 'p'

    await t.exception(findVanityKey(prefix, 'multisig', config, gpuOptions), /limits/)

    let fallback = null
    const namespace = await findVanityKey(prefix, 'multisig', config, {
      ...gpuOptions,
      backend: 'auto',
      workers: 1,
      onFallback: (err) => {
        fallback = err
      }
    })

    t.ok(fallback instanceof Error)
    t.ok(namespace.startsWith(config.namespace + '$'))
    t.ok(multisigKey(namespace, config).startsWith(prefix))
  })

  test(`${label} touch returns distinct, usable signing keys`, { skip }, async (t) => {
    const a = await findVanityKey('pe', 'touch', undefined, gpuOptions)
    const b = await findVanityKey('p', 'touch', undefined, gpuOptions)
    t.ok(pearKey(a.publicKey).startsWith('pe'))
    t.ok(pearKey(b.publicKey).startsWith('p'))
    t.not(a.publicKey.toString('hex'), b.publicKey.toString('hex'))
    const message = Buffer.from(label + ' signing test')
    t.ok(crypto.verify(message, crypto.sign(message, a.secretKey), a.publicKey))
    t.ok(crypto.verify(message, crypto.sign(message, b.secretKey), b.publicKey))
  })

  test(
    `${label} multisig handles multiple blocks, UTF-8 and namespace suffixes`,
    { skip },
    async (t) => {
      // The native search appends 81 ASCII bytes. Exercise BLAKE2b's 127/128/129-byte boundary.
      for (const base of ['n'.repeat(46), 'n'.repeat(47), 'n'.repeat(48), '测试$namespace']) {
        const config = generateMultisigConfig()
        config.namespace = base + '$old'
        const prefix = multisigKey(config.namespace, config).startsWith('pe') ? 'ea' : 'pe'
        const namespace = await findVanityKey(prefix, 'multisig', config, gpuOptions)
        t.ok(namespace.startsWith(base + '$'))
        t.ok(multisigKey(namespace, config).startsWith(prefix))
        config.namespace = namespace
        t.is(await findVanityKey(prefix, 'multisig', config, gpuOptions), namespace)
      }
    }
  )

  test(
    `${label} benchmark checks full batches and partial workgroups with bounded readback`,
    { skip },
    async (t) => {
      for (const type of ['touch', 'multisig']) {
        const stats = await findVanityKey.benchmark(
          type,
          type === 'multisig' ? generateMultisigConfig() : undefined,
          {
            ...gpuOptions,
            batchSize: 65,
            batches: 2
          }
        )
        t.is(stats.backend, backend)
        t.is(stats.mode, type)
        t.is(stats.batchSize, 65)
        t.is(stats.candidates, 130)
        t.is(stats.readbackBytesPerBatch, 580)
        t.ok(stats.seconds > 0)
        t.ok(stats.candidatesPerSecond > 0)
        t.ok(stats.device.length > 0)
        t.ok(stats.preparationSeconds >= 0)
        t.ok(stats.dispatchSeconds > 0)
        t.ok(stats.verificationSeconds > 0)
        t.ok([null, 32].includes(stats.requiredSubgroupSize))
        if (stats.gpuSeconds !== null) {
          t.ok(stats.gpuSeconds > 0)
          // Batches overlap verification, so GPU time can exceed CPU wait time
          // but never the measured wall time.
          t.ok(stats.gpuSeconds <= stats.seconds * 1.02)
        }
        t.ok(
          stats.preparationSeconds + stats.dispatchSeconds + stats.verificationSeconds <=
            stats.seconds * 1.01
        )
      }
    }
  )

  test(
    `${label} seed derivation covers both pipeline slots and the maximum touch batch`,
    // A maximum batch takes well under a second on a GPU but can exceed the
    // default 30s on software drivers on small CI runners.
    { skip, timeout: 180000 },
    async (t) => {
      // Two small batches exercise both pipeline slots; one maximum batch covers
      // the largest dispatch.
      for (const [batchSize, batches] of [
        [64, 3],
        [1048576, 1]
      ]) {
        const stats = await findVanityKey.benchmark('touch', undefined, {
          ...gpuOptions,
          batchSize,
          batches
        })

        // Startup samples cross a 32-bit ChaCha20 counter carry; every full batch
        // independently checks eight seeds, Ed25519 public keys, and manifest hashes.
        t.is(stats.candidates, batchSize * batches)
        t.is(stats.batchSize, batchSize)
        t.is(stats.readbackBytesPerBatch, 580)
      }
    }
  )

  test(`terminating a Bare worker releases a live ${label} context`, { skip }, async (t) => {
    const Worker = require('bare-worker')
    // Context allocation alone needs a bounded template; no dispatch uses this fixture.
    const configuration = 'touch\np\n' + Buffer.alloc(128).toString('hex') + '\n\n64\n'
    for (let i = 0; i < 2; i++) {
      const worker = new Worker(require.resolve('./fixtures/idle-gpu'), {
        workerData: { configuration, backend }
      })
      await new Promise((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      worker.ref()
      await worker.terminate()
      t.pass('live native context terminated without crashing')
    }
  })

  test(`${label} native handles and configurations reject malformed input`, { skip }, async (t) => {
    const binding = require('../binding')
    const configuration = 'touch\n\n' + Buffer.alloc(128).toString('hex') + '\n\n64\n'
    const create = (input) => binding.create(input, backend, true, 64, 0, '')

    for (const invalid of [{}, Object.create(null), null, 0, 'handle']) {
      await t.exception(() => binding.step(invalid))
      await t.exception(() => binding.close(invalid))
    }

    for (const offsets of ['64 junk', '64 4294967296', '64 -1', '64 65']) {
      await t.exception(() => create(configuration.replace('64\n', offsets + '\n')))
    }
    await t.exception(() => create(configuration + 'extra\n'))
    await t.exception(() => binding.create(configuration, 'cuda', true, 64, 0, ''), /backend/)
    await t.exception(() => binding.create(configuration, backend, true, 64, 0))

    const handle = create(configuration)
    await t.exception(() => binding.step(Object.create(handle)))
    binding.close(handle)
    binding.close(handle)
    await t.exception(() => binding.step(handle), /closed/)

    // Dynamic paths must work inside prepared worker bundles too.
    const pair = await findVanityKey('', 'touch', undefined, {
      ...gpuOptions,
      addon:
        __dirname + '/../prebuilds/' + os.platform() + '-' + os.arch() + '/pear-vanity-gpu.bare'
    })
    t.is(pair.publicKey.length, 32)
  })

  if (backend === 'vulkan') continue

  test(
    `${label} kernels are cached privately and corrupt entries are rebuilt`,
    { skip },
    async (t) => {
      const cacheDirectory =
        os.tmpdir() + '/pear-vanity-gpu-test-' + crypto.randomBytes(8).toString('hex') + '/cache'
      const options = { ...gpuOptions, cacheDirectory }

      try {
        const first = await findVanityKey('p', 'touch', undefined, options)
        t.ok(pearKey(first.publicKey).startsWith('p'))

        const entries = fs.readdirSync(cacheDirectory).filter((name) => name.endsWith('.bin'))
        t.is(entries.length, 1, 'one compiled touch kernel is cached')
        t.is(fs.statSync(cacheDirectory).mode & 0o777, 0o700, 'cache directory is private')

        const entry = cacheDirectory + '/' + entries[0]
        t.is(fs.statSync(entry).mode & 0o777, 0o600, 'cache entry is private')

        const second = await findVanityKey('p', 'touch', undefined, options)
        t.ok(pearKey(second.publicKey).startsWith('p'), 'cached kernel is reused')

        const data = fs.readFileSync(entry)
        data[data.length - 1] ^= 1
        fs.writeFileSync(entry, data)

        const third = await findVanityKey('p', 'touch', undefined, options)
        t.ok(pearKey(third.publicKey).startsWith('p'), 'corrupt entry is ignored')
        t.unlike(fs.readFileSync(entry), data, 'corrupt entry is replaced')

        // A valid entry renamed over another key's file must not be loaded.
        const config = generateMultisigConfig({ avoid: ['p'] })
        await findVanityKey('p', 'multisig', config, options)
        const multisigEntry = fs
          .readdirSync(cacheDirectory)
          .find((name) => name.endsWith('.bin') && name !== entries[0])
        t.ok(multisigEntry, 'multisig kernel is cached separately')
        fs.copyFileSync(entry, cacheDirectory + '/' + multisigEntry)
        const namespace = await findVanityKey('p', 'multisig', config, options)
        t.ok(multisigKey(namespace, config).startsWith('p'), 'swapped entry is rebuilt')
        t.unlike(
          fs.readFileSync(cacheDirectory + '/' + multisigEntry),
          fs.readFileSync(entry),
          'swapped entry is replaced'
        )

        const uncached = await findVanityKey('p', 'touch', undefined, {
          ...gpuOptions,
          cacheDirectory: false
        })
        t.ok(pearKey(uncached.publicKey).startsWith('p'), 'caching can be disabled')
      } finally {
        fs.rmSync(cacheDirectory.slice(0, -'/cache'.length), { recursive: true, force: true })
      }
    }
  )
}
