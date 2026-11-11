'use strict'

const Worker = require('bare-worker')
const binding = require('../../binding')
const { configuration, backend } = Worker.workerData
const handle = binding.create(configuration, backend, true, 64, 0, '')
Worker.parentPort.postMessage('ready')
setInterval(() => void handle, 1000)
