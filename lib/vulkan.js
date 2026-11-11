'use strict'

const gpu = require('./gpu')

module.exports = function vulkanVanity(target, type, config, options = {}) {
  return gpu.search('vulkan', target, type, config, options)
}

module.exports.benchmark = function benchmark(type, config, options = {}) {
  return gpu.benchmark('vulkan', type, config, options)
}
