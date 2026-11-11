'use strict'

// Node.js entry point for the opencl backend; see node/host.js.
const host = require('./host')

module.exports = function openclVanity(target, type, config, options = {}) {
  return host.call('opencl', 'search', [target, type, config, options], options)
}

module.exports.benchmark = function benchmark(type, config, options = {}) {
  return host.call('opencl', 'benchmark', [type, config, options], options)
}
