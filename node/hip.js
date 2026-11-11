'use strict'

// Node.js entry point for the hip backend; see node/host.js.
const host = require('./host')

module.exports = function hipVanity(target, type, config, options = {}) {
  return host.call('hip', 'search', [target, type, config, options], options)
}

module.exports.benchmark = function benchmark(type, config, options = {}) {
  return host.call('hip', 'benchmark', [type, config, options], options)
}
