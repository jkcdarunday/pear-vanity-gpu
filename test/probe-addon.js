'use strict'

// Loads this platform's prebuilt addon and reports which GPU backends can open a
// device. CI runs it where no GPU tests are possible, so a broken or unloadable
// prebuild fails even though the CPU suite never touches the addon.
const binding = require('../binding')

for (const name of ['create', 'step', 'close']) {
  if (typeof binding[name] !== 'function') throw new Error('Addon is missing ' + name)
}

const configuration = 'touch\np\n' + Buffer.alloc(128).toString('hex') + '\n\n64\n'

for (const backend of ['vulkan', 'opencl', 'hip']) {
  try {
    const handle = binding.create(configuration, backend, true, 64, false, '')
    binding.close(handle)
    console.log(backend + ': device available')
  } catch (err) {
    if (err.code !== 'ERR_VANITY_GPU') throw err
    console.log(backend + ': ' + err.message)
  }
}

console.log('addon loaded')
