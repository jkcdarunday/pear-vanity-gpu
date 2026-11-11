#!/usr/bin/env node
'use strict'

// Under Bare the command runs here; under Node.js it runs in a Bare child process.
if (typeof Bare !== 'undefined') require('../lib/cli')
else require('../node/host').exec('lib/cli.js', process.argv.slice(2))
