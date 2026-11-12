'use strict'

// Human-readable numbers for the command-line tool.

exports.label = function label(backend) {
  return { cpu: 'CPU', vulkan: 'Vulkan', opencl: 'OpenCL', hip: 'HIP' }[backend] || backend
}

exports.where = function where(progress) {
  if (!progress) return ''

  return exports.label(progress.backend) + (progress.device ? ` (${progress.device})` : '')
}

// Short-scale names: K thousand, M million, B billion, T trillion, Q quadrillion.
// Anything larger, as for very long prefixes, uses scientific notation.
exports.count = function count(value) {
  const units = ['', 'K', 'M', 'B', 'T', 'Q']
  let unit = 0

  if (value >= 1e18) return value.toExponential(2).replace('e+', 'e')

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }

  return (unit === 0 ? Math.round(value).toString() : value.toPrecision(3)) + units[unit]
}

exports.duration = function duration(seconds) {
  if (!Number.isFinite(seconds)) return 'forever'
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`

  const steps = [
    [60, 'm'],
    [60, 'h'],
    [24, 'd'],
    [365.25, 'y']
  ]
  let value = seconds
  let unit = 's'

  for (const [size, name] of steps) {
    if (value < size) break
    value /= size
    unit = name
  }

  return unit === 'y' && value >= 1000 ? `${exports.count(value)}y` : `${value.toFixed(1)}${unit}`
}
