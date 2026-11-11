'use strict'

const gpu = require('./gpu')

module.exports = function hipVanity(target, type, config, options = {}) {
  return gpu.search('hip', target, type, config, options)
}

module.exports.benchmark = function benchmark(type, config, options = {}) {
  return gpu.benchmark('hip', type, config, options)
}
