'use strict'

// `npm run benchmark -- ...` is `pear-vanity-gpu benchmark ...`.
require('../lib/cli')(['benchmark', ...Bare.argv.slice(2)])
