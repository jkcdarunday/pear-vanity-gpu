'use strict'

// Translates the production GLSL search shader and generated field arithmetic
// into one portable C-like kernel used by the OpenCL and HIP backends. Every
// rewrite must match; a shader change that breaks a rule fails the build
// instead of silently producing a different kernel.
const fs = require('bare-fs')

const [shaderPath, fieldPath, outputPath] = Bare.argv.slice(2)

if (!shaderPath || !fieldPath || !outputPath) {
  throw new Error('Usage: bare generate-kernel.js search.comp field.glsl kernel.h')
}

let source = fs.readFileSync(shaderPath, 'utf8')
const field = fs.readFileSync(fieldPath, 'utf8')

function replace(pattern, replacement, { min = 1, max = Infinity } = {}) {
  let count = 0

  source = source.replace(pattern, (...match) => {
    count++

    return typeof replacement === 'function' ? replacement(...match) : expand(replacement, match)
  })

  if (count < min || count > max) {
    throw new Error(`Kernel translation rule ${pattern} matched ${count} times`)
  }
}

function expand(replacement, match) {
  return replacement.replace(/\$(\d)/g, (_, index) => match[Number(index)] ?? '')
}

const start = source.indexOf('#if TOUCH')

if (start === -1) throw new Error('Shader is missing its TOUCH section')
source = source.slice(start)

replace('#include "field.glsl"', () => field, { max: 1 })

// Exact signed 32x32 products expressed directly; OpenCL and HIP compilers
// lower this better than the GLSL extended-multiply sequence.
replace(
  /int64_t product\(int a, int b\) \{[\s\S]*?\n\}/,
  'int64_t product(int a, int b) { return ((int64_t)a) * b; }',
  { max: 1 }
)

replace(/struct (Field|Point) \{([\s\S]*?)\};/g, 'typedef struct {$2} $1;', { min: 2, max: 2 })
// GLSL passes arrays by copy; C passes them by reference. This is only safe
// while callees never write an `in` array parameter (reduce() mutates its
// argument but is only ever tail-called with a temporary).
replace(/\b(?:inout|out) /g, '')
replace(/(uint(?:64_t)?\[\])\(([\s\S]*?)\);/g, '{$2};')
replace(
  'uint x[16] = initial;',
  'uint x[16];\n  for (int i = 0; i < 16; i++)\n    x[i] = initial[i];',
  {
    max: 1
  }
)
replace(
  'uint unused[8] = replacement;',
  'uint unused[8];\n    for (int i = 0; i < 8; i++)\n      unused[i] = replacement[i];',
  { max: 1 }
)

// GLSL scalar and aggregate constructors become C casts and compound literals.
const constructor = /\b(uint64_t|int64_t|uint|int|Point)\(/
let constructors = 0

for (;;) {
  const match = constructor.exec(source)

  if (!match) break

  const open = match.index + match[0].length
  let depth = 1
  let end = open

  while (depth) {
    if (end >= source.length) throw new Error('Unbalanced constructor in shader')
    if (source[end] === '(') depth++
    else if (source[end] === ')') depth--
    end++
  }

  const name = match[1]
  const args = source.slice(open, end - 1)

  source =
    source.slice(0, match.index) +
    (name === 'Point' ? `(Point){${args}}` : `((${name})(${args}))`) +
    source.slice(end)
  constructors++
}

if (constructors === 0) throw new Error('Kernel translation found no constructors')

replace(/^const (uint(?:64_t)? )/gm, 'CONSTANT_DATA $1')

// Buffers and push constants become kernel arguments carried in a context.
const names = [...source.matchAll(/^(?:void|uint|uint64_t|int64_t|int|Field|Point) (\w+)\(/gm)].map(
  (m) => m[1]
)

if (!names.includes('main')) throw new Error('Shader is missing main')

const helpers = names.filter((name) => name !== 'main')

for (const name of helpers) {
  replace(new RegExp('\\b' + name + '\\(', 'g'), name + '(ctx, ')
}

for (const name of helpers) {
  replace(
    new RegExp('^(void|uint|uint64_t|int64_t|int|Field|Point) ' + name + '\\(ctx, ', 'm'),
    'DEVICE_FN $1 ' + name + '(Context ctx, ',
    { max: 1 }
  )
}

replace(/ctx, \)/g, 'ctx)', { min: 0 })
replace('uint id = gl_GlobalInvocationID.x;', 'uint id = GLOBAL_ID;', { max: 1 })
replace('atomicCompSwap(winner,', 'ATOMIC_CAS(&winner,', { max: 1 })
replace(
  'void main() {',
  'KERNEL_ENTRY searchKernel(CONFIG_POINTER configuration, TABLE_POINTER basepoint,\n' +
    '                          OUTPUT_POINTER output, Parameters parameters) {\n' +
    '  Context ctx = {parameters, configuration, basepoint, output};',
  { max: 1 }
)

// Resolve ambiguous signed/unsigned min overloads.
replace(/min\((128|7|8),/g, 'min($1u,', { min: 3, max: 3 })

const common = `typedef struct {
  uint mode, count, templateLen, namespaceLen, offsetCount, targetLen, counterLow,
      counterHigh, diagnosticCount;
} Parameters;

typedef struct {
  Parameters parameters;
  CONFIG_POINTER configuration;
  TABLE_POINTER basepoint;
  OUTPUT_POINTER output;
} Context;

#define p ctx.parameters
#define cfg ctx.configuration
#define table ctx.basepoint
#define winner ctx.output[0]
#define results (ctx.output + 1)
`

const opencl = `typedef ulong uint64_t;
typedef long int64_t;
#define DEVICE_FN static inline __attribute__((always_inline))
#define CONSTANT_DATA __constant const
#define CONFIG_POINTER __constant const uint *
#define TABLE_POINTER __global const uint *
#define OUTPUT_POINTER __global uint *
#define KERNEL_ENTRY __kernel void
#define GLOBAL_ID ((uint)get_global_id(0))
#define ATOMIC_CAS(pointer, expected, value) atomic_cmpxchg(pointer, expected, value)
`

const hip = `typedef unsigned int uint;
typedef unsigned long long uint64_t;
typedef long long int64_t;
#define DEVICE_FN static __device__ __forceinline__
#define CONSTANT_DATA __device__ __constant__ const
#define CONFIG_POINTER const uint *
#define TABLE_POINTER const uint *
#define OUTPUT_POINTER uint *
#define KERNEL_ENTRY extern "C" __global__ void
#define GLOBAL_ID (blockIdx.x * blockDim.x + threadIdx.x)
#define ATOMIC_CAS(pointer, expected, value) atomicCAS(pointer, expected, value)
`

function literal(name, text) {
  const lines = text.split('\n').map((line) => '  "' + escape(line) + '\\n"')

  return `static const char ${name}[] =\n${lines.join('\n')};\n`
}

function escape(line) {
  return line.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\?\?/g, '?\\?')
}

fs.writeFileSync(
  outputPath,
  '// Generated by generate-kernel.js from search.comp and field.glsl.\n#pragma once\n' +
    literal('opencl_prelude', opencl) +
    literal('hip_prelude', hip) +
    literal('kernel_source', common + source)
)
