'use strict'

const gpu = require('./gpu')

module.exports = function openclVanity(target, type, config, options = {}) {
  return gpu.search('opencl', target, type, config, options)
}

module.exports.benchmark = function benchmark(type, config, options = {}) {
  return gpu.benchmark('opencl', type, config, options)
}
