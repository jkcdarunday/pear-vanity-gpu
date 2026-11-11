'use strict'

require('../lib/benchmark')
  .run(Bare.argv.slice(2))
  .catch((err) => {
    console.error(err.message)
    Bare.exitCode = 1
  })
