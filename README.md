# pear-vanity-gpu

CPU, Vulkan, OpenCL and HIP vanity searches for Hypercore keys on Bare. Native packaging follows
`bare-fs`: `cmake-bare`, `BARE_MODULE`, `require.addon()`, and platform-specific
`prebuilds/<platform>-<arch>/pear-vanity-gpu.bare` files. Consumers do not run CMake or
compile shaders. GPU runtimes are loaded on demand, so the addon loads on hosts
without Vulkan, OpenCL or ROCm. Missing or unsupported GPU backends fall back to
the next backend and finally to Bare CPU workers.

## Usage

Requires Bare 1.36.0 or newer (the validated runtime). This package does not support the Node.js runtime.
Install with `npm install pear-vanity-gpu` and run your application with Bare.

```js
'use strict'

const findVanityKey = require('pear-vanity-gpu')

async function main() {
  const pair = await findVanityKey('pe', 'touch', undefined, {
    backend: 'auto',
    workers: 2
  })

  console.log(pair.publicKey.toString('hex'))
}

main().catch(console.error)
```

`findVanityKey(prefix, type = 'touch', config, options = {})` returns a promise.
Touch searches return `{ publicKey, secretKey }`. Multisig searches return a
namespace string and require `{ publicKeys, namespace, quorum }` as `config`.
Keys may be 32-byte buffers or Hypercore key strings; quorum defaults to a
majority and must be between one and the signer count. A matching namespace is
returned unchanged. Existing `$suffix` portions are replaced when searching.

Prefixes use the lowercase z32 alphabet, up to 52 characters; an empty prefix
matches any key. Work grows exponentially with prefix length. Protect returned
secret keys and avoid logging them.

| Option | Behavior |
| --- | --- |
| `backend` | `auto` (default) tries the GPU backends fastest first, then CPU; `cpu` skips the GPU; `vulkan`, `opencl` or `hip` use only that backend and reject its errors. |
| `workers` | CPU workers, from 1 to 256; defaults to available parallelism capped at 32. |
| `batchSize` | GPU candidates per batch, from 64 to 1048576; otherwise device defaults apply. |
| `onFallback(error)` | Called for each automatic GPU attempt that fails; `error.backend` names it. Invalid inputs and cancellation do not trigger fallback. |
| `signal` | An AbortSignal-compatible object; cancellation rejects with `AbortError` and `ABORT_ERR`. Bare requires a caller-provided controller implementation. |
| `allowSoftware` | Boolean, default `false`; enables software Vulkan and OpenCL devices for correctness testing. |
| `addon` | Optional native addon path override, primarily for diagnostics. |
| `cacheDirectory` | Absolute directory for compiled OpenCL/HIP kernels, or `false` to disable caching. |

`PEAR_VANITY_BACKEND` sets the default backend, `PEAR_VANITY_VULKAN_BATCH`
sets the default GPU batch size for every backend, and `PEAR_VANITY_CACHE_DIR`
sets the kernel cache directory. Explicit options take precedence. Invalid options
reject before searching. Cancellation and completion wait for worker teardown;
an in-flight GPU dispatch must finish before its worker can stop.

The `pear-vanity-gpu/vulkan`, `pear-vanity-gpu/opencl` and `pear-vanity-gpu/hip`
entries expose each GPU search function directly.
`findVanityKey.benchmark(type, config, { backend, batchSize, batches, allowSoftware })`
runs fixed work on one GPU backend (`vulkan` by default); `batches` defaults to 10
and accepts 1 to 100000. Benchmarks never fall back to another backend or CPU.

## GPU backends

| Backend | Runtime required at run time | Devices | Notes |
| --- | --- | --- | --- |
| `vulkan` | Vulkan 1.1 loader and driver with `shaderInt64` | Any vendor | Precompiled SPIR-V; lowest setup cost. |
| `opencl` | OpenCL 1.2 ICD loader and full-profile driver | Any vendor | Kernel compiled by the driver on first use, then cached. |
| `hip` | ROCm HIP runtime and hiprtc (6.x or 7.x) | AMD GPUs | Kernel compiled for the current GPU on first use, then cached; uses device 0 after `HIP_VISIBLE_DEVICES`. |

In `auto` mode, touch searches try HIP, OpenCL, then Vulkan; multisig searches
try OpenCL, HIP, then Vulkan. This follows the measured batch throughput below.
Each failed attempt calls `onFallback` and moves on; if every GPU backend fails,
the search runs on CPU workers. The OpenCL and HIP setup costs are higher than
Vulkan's (about 0.20s and 0.15s versus 0.11s on the reference host), so Vulkan can
finish very short searches sooner; their throughput advantage takes over beyond
roughly 5 million touch or 50 million multisig candidates (about four to five
prefix characters). Use an explicit `backend` when you need one specific runtime.

All backends share one search pipeline. The OpenCL and HIP kernels are generated
at build time from the same GLSL shader and generated field arithmetic as Vulkan,
and every backend passes the same deterministic native vectors and CPU
differential checks. GPU work runs in a Bare worker, keeping the main event loop
responsive, and worker teardown releases native GPU resources.

Compiled OpenCL and HIP kernels are cached in `$XDG_CACHE_HOME/pear-vanity-gpu`
(default `~/.cache/pear-vanity-gpu`; `~/Library/Caches` on macOS). Entries contain
only public kernel code, are keyed by the kernel source, build options, runtime,
driver and device, and carry a BLAKE2b checksum. The directory and files are
created owner-only; entries that are corrupt, foreign-owned or writable by others
are ignored and rebuilt. Caching is best effort: an unwritable directory only costs
compile time (about 1.5s for touch on the reference host). Windows does not cache
kernels yet, so OpenCL and HIP compile on every run there.

Software adapters (llvmpipe, PoCL or CPU OpenCL runtimes) are excluded unless
explicitly enabled with `allowSoftware: true` for testing. Prebuilding regenerates
a conditional `#binding` map from available prebuilds, so bundling unsupported
targets retains CPU fallback without resolving a missing addon. GPU support
depends on the platform prebuilds included in the package; other platforms retain
CPU support. Release prebuilds should be produced on the oldest supported distribution.

## Security

Vanity searching retains Ed25519 keys and full 256-bit Hypercore identifiers.
Matching prefixes are intentional and do not authenticate an identity: always
compare the complete identifier. A prefix of `n` z32 characters fixes
`min(5 * n, 256)` identifier bits. Under the ideal-hash model, independently
selected identifiers sharing that prefix have fewer unfixed bits, so their
conditional collision probability increases; finding each accepted identifier
also requires the corresponding search work. For example, four characters leave
236 unfixed bits. These counts do not measure Ed25519 signing strength or seed
entropy. There is no uniqueness guarantee for generated keys.

Each GPU search uses fresh OS-backed randomness and never wraps its candidate
counter. Winners are checked independently on the CPU before returning. Keep
`secretKey` private and clear it when finished. CPU workers clear discarded secret
keys; native teardown attempts to wipe host/device search-secret buffers.
JavaScript strings, driver copies, GPU registers and abrupt process termination
prevent a guarantee that every secret copy is erased. Use a trusted host and GPU;
the custom GPU implementation has no constant-time or shared-device isolation guarantee.
The optional `addon` path loads executable native code and must be trusted.

`npm run test:native` runs deterministic GPU differential vectors, counter-boundary
checks, 20,006 field comparisons with undefined-behavior sanitization, an
independent check of all 4,128 fixed-base table points, and a check that GPU
runtimes are never linked directly. Set `VANITY_NATIVE_BACKENDS` (default
`vulkan`) to a comma-separated list such as `vulkan,opencl,hip` to run the vectors
on each backend. It requires Python 3.8+, a C++ compiler and the selected runtimes. These regression checks and the internal security review
are not an independent cryptographic audit or a proof of collision resistance.

## GPU implementation

Touch starts with one fresh 256-bit search secret from libsodium's OS-backed
randomness. The GPU derives each 32-byte seed using
[ChaCha20](https://doc.libsodium.org/advanced/stream_ciphers/chacha20) with a
64-bit block counter, expands it with
[SHA-512](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf), and performs
Ed25519 fixed-base multiplication, manifest hashing, and prefix matching.
There is no per-batch seed/scalar upload. The CPU reconstructs and independently
verifies samples and winners using libsodium. Search secrets are cleared from
CPU memory and GPU configuration buffers during teardown.

Multisig hashes namespaces and complete manifests on the GPU. Candidates preserve
the base namespace and use a random salt plus a counter as the suffix. Installed
Hypercore serialization supplies templates and patch offsets. Startup checks
include a 32-bit counter carry; benchmarks verify eight samples per batch, and
both native code and JavaScript verify winners before returning them.

Separate shaders specialize touch and multisig. Touch uses 32 eight-bit fixed-base
windows with signed digits and a 484 KiB affine cached-point table. Ten alternating 26/25-bit limbs
keep point coordinates in 32-bit registers; generated wide products and carry
reductions retain exact arithmetic. Grouped coefficients, explicit high/low-word
packing, and interleaved ref10 carries reduce register pressure. Supported AMD
devices use feature-checked 32-lane subgroups; other devices retain their default.
Readback remains bounded to 580 bytes per
batch. Every backend keeps two batches in flight: the GPU runs the next batch while
the CPU reads back and verifies the previous one, and results are still verified
in counter order. Hardware defaults use 1048576 candidates per batch for prefixes
of five or more characters, which keeps the GPU 95–98% busy for touch. Shorter
touch prefixes use 1024 (up to two characters), 8192 (three) or 65536 (four), and
shorter multisig prefixes use 65536, so little work is wasted after a match.
Software Vulkan and OpenCL check correctness; performance depends on the device and workload.

OpenCL and HIP use the same arithmetic but express each exact 32×32-bit product
directly as a 64-bit multiply, which their LLVM-based compilers schedule with fewer
registers. They use 64-lane work-groups for touch and 128 for multisig.

Native limits are 4096 manifest bytes, 64 signer fields, and 1983 UTF-8 namespace
bytes for every GPU backend. Auto mode falls back to CPU for requests exceeding these limits.

## Benchmark results

Measured on November 10, 2026 using an AMD Ryzen 9 7950X (16 cores, 32 threads),
AMD Radeon RX 7900 XTX, Mesa RADV 26.2.6, AMD OpenCL 3581.0, ROCm 7.2 and Bare
1.36.0, with two batches in flight and warm shader and kernel caches. Multisig
uses three signers and quorum two; both modes check a ten-character prefix.

Batch throughput, median of four runs with batch sizes rotated (33.5M touch and
67.1M multisig candidates per run). The speedup is against the CPU baseline below:

| Workload | Batch | CPU, 32 threads | Vulkan | OpenCL | HIP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Touch | 65,536 | | 26.4 M/s | 40.1 M/s | 41.2 M/s |
| Touch | 1,048,576 | ~1.09 M/s | 30.3 M/s (~28×) | 49.1 M/s (~45×) | **49.5 M/s (~45×)** |
| Multisig | 65,536 | | 395 M/s | 548 M/s | 327 M/s |
| Multisig | 1,048,576 | ~1.77 M/s | 485 M/s (~274×) | **799 M/s (~451×)** | 377 M/s (~213×) |

Batch throughput covers dispatch, readback and eight CPU-verified samples per
batch; it excludes startup, compilation and teardown. The CPU rates are the
full-command CPU times below divided into the candidate counts, so they include
process startup and the GPU ratios are slightly generous.

Full command, median of three rotated runs at batch 1048576, from launching
`bare scripts/benchmark.js` until it exits:

| Workload | Candidates | CPU, 32 processes | Vulkan | OpenCL | HIP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Touch | 16,777,216 | 15.341s | 0.949s (16.2×) | 0.825s (18.6×) | 0.787s (19.5×) |
| Multisig | 8,388,608 | 4.740s | 0.395s (12.0×) | 0.486s (9.8×) | 0.471s (10.1×) |

The CPU baseline runs 32 concurrent single-thread Bare processes. These fixed
workloads are short, so setup (about 0.11s for Vulkan, 0.15s for HIP and 0.20s
for OpenCL) dominates multisig; longer searches converge on the batch-throughput
ratios. Results apply to this host and workload.

Expected time to find a match, calculated from the throughput above rather than
timed. A z32 character carries 5 bits, so an n-character prefix needs 32ⁿ
candidates on average; real searches vary widely because a match is luck.

| Prefix | Candidates | Touch, CPU | Touch, HIP | Multisig, CPU | Multisig, OpenCL |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5 characters | 33.5M | ~31 s | ~1 s | ~19 s | ~0.25 s |
| 6 characters | 1.07B | ~16 min | ~22 s | ~10 min | ~1.5 s |
| 7 characters | 34B | ~8.7 h | ~12 min | ~5.4 h | ~43 s |
| 8 characters | 1.1T | ~12 days | ~6 h | ~7 days | ~23 min |

## Develop and package

Install CMake 4+, a C++17 compiler, Vulkan and OpenCL headers, glslangValidator
and libsodium development files. On Debian/Ubuntu the native dependencies are
`glslang-tools libvulkan-dev opencl-headers libsodium-dev`. ROCm headers are not
needed: the addon declares the small HIP C ABI it loads at run time. Build-time generation uses Bare and
`bare-fs`. Dependencies are needed only in this library's build environment.

Run commands from `src/` in this repository.

```sh
npm ci
npm rebuild bare-runtime --ignore-scripts
npm run lint
npm run prebuild
npm test
PEAR_TEST_VULKAN=1 PEAR_TEST_VULKAN_SOFTWARE=1 npm test
PEAR_TEST_OPENCL=1 PEAR_TEST_OPENCL_SOFTWARE=1 npm test
PEAR_TEST_HIP=1 npm test
npm run benchmark -- touch --allow-software --batch 256 --batches 2
npm run benchmark -- touch --backend both --batch 65536 --batches 8
npm run benchmark -- multisig --backend both --batch 65536 --batches 16
npm run benchmark -- touch --backend vulkan,opencl,hip --batch 65536 --batches 256
npm run pack
```

Release prebuilds include shaders, kernel source, tables and statically linked
libsodium. Linux also links the C++ runtime statically. The addon needs only the C
library at load time; the system Vulkan loader, OpenCL ICD loader or ROCm runtime
and a matching driver are needed only for the backend that uses them.
No install lifecycle script builds native dependencies. The tarball contains
source plus available prebuilds, and consumers can install it directly.

The CLI accepts `--backend cpu|vulkan|opencl|hip|both|all` or a comma-separated
list (default `vulkan`; `both` is CPU and Vulkan) and defaults to
65536 candidates per batch. CPU measurements
use one thread running the JavaScript/libsodium search operations; they are not
all-core CPU results. Both backends hash complete Hypercore manifests and test
the same ten-character prefix for the requested candidate count. Use repeated
runs and compare medians. GPU output separates measured batch work from total
time including worker/pipeline setup and teardown; short searches can be dominated
by that overhead. CPU runs below the millisecond clock resolution reject; increase `--batches`.

Fixed-work benchmarks report device, candidate count, elapsed seconds, throughput
and readback size. Native timing excludes pipeline setup and includes GPU seed
generation, scalar expansion, dispatch, readback, and eight CPU differential
samples per batch. `preparationSeconds`, `dispatchSeconds`, and
`verificationSeconds` expose CPU wall-clock phases; dispatch includes submission,
transfers, and waiting for GPU completion. Because batches overlap verification,
`gpuSeconds` can exceed `dispatchSeconds` but not `seconds`. `gpuSeconds` measures dispatch with
Vulkan timestamp queries (when the queue supports them, otherwise `null`), OpenCL
profiling events or HIP events. `backend` names the measured backend.
`requiredSubgroupSize` reports a requested Vulkan subgroup width, or `null` for
the driver default and for OpenCL/HIP. Tests cover
CPU fallback, signatures, namespace preservation, UTF-8, hash block boundaries,
and partial workgroups. Field arithmetic derives from public-domain TweetNaCl;
see NOTICE for third-party licensing.

For local environments without static libsodium, configure
`cmake -S . -B out/addon -DVANITY_STATIC_SODIUM=OFF` before building. Such addons
require the matching system libsodium at runtime and should not be distributed
as self-contained release prebuilds. Release CI retains static linking and builds
checksum-pinned, upstream-signature-verified libsodium 1.0.22 using
`sh scripts/build-sodium.sh /absolute/install/prefix`.

`npm run pack` regenerates the binding map from the addons actually present and
creates the npm tarball. To produce a CPU-only package, remove local `prebuilds/`
first, then run `npm run pack`. Never redistribute a development-host addon
without checking its runtime dependencies and compatibility baseline.

Formatting uses Prettier and Lunte for JavaScript and clang-format for C++/GLSL.
`npm run format` applies all three; `npm run lint` checks without modifying files.
Root workflows test CPU behavior on Linux, macOS, and Windows, and build/test
Linux x64 and arm64 addons in Ubuntu 22.04 containers with software Vulkan
(llvmpipe), software OpenCL (PoCL), native cryptographic regression checks and a
linkage check. HIP requires AMD hardware and must be validated outside hosted CI
with `PEAR_TEST_HIP=1 npm test` and `VANITY_NATIVE_BACKENDS=hip npm run test:native`. These configured CI jobs still
need to run on the hosting service before release.

## License

Copyright 2026 Jan Keith Darunday. Licensed under the Apache License, Version 2.0.
See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the license and bundled third-party
attribution.
