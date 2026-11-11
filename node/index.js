'use strict'

// Node.js entry point. The search runs in a Bare child process; see node/host.js.
const host = require('./host')

module.exports = function findVanityKey(start, type = 'touch', config = undefined, options = {}) {
  return host.call('.', 'search', [start, type, config, options], options)
}

module.exports.benchmark = function benchmark(type, config, options = {}) {
  return host.call('.', 'benchmark', [type, config, options], options)
}
