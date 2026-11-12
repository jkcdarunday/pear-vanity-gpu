#!/usr/bin/env node
'use strict'

// Under Bare the command runs here; under Node.js this file is started again in
// a Bare child process.
if (typeof Bare !== 'undefined') require('../lib/cli')()
else require('../node/host').exec('bin/pear-vanity-gpu.js', process.argv.slice(2))
