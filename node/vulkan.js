'use strict'

// Node.js entry point for the vulkan backend; see node/host.js.
const host = require('./host')

module.exports = function vulkanVanity(target, type, config, options = {}) {
  return host.call('vulkan', 'search', [target, type, config, options], options)
}

module.exports.benchmark = function benchmark(type, config, options = {}) {
  return host.call('vulkan', 'benchmark', [type, config, options], options)
}
