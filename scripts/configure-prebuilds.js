'use strict'

const fs = require('bare-fs')
const root = __dirname + '/..'
const pkg = JSON.parse(fs.readFileSync(root + '/package.json', 'utf8'))
const bindings = {}
const hosts = fs.existsSync(root + '/prebuilds') ? fs.readdirSync(root + '/prebuilds') : []

for (const host of hosts.sort()) {
  if (!fs.existsSync(`${root}/prebuilds/${host}/${pkg.name}.bare`)) continue

  if (!/^[a-z0-9]+-[a-z0-9]+$/.test(host)) throw new Error('Invalid prebuild host: ' + host)

  const [platform, arch] = host.split('-')

  if (!bindings[platform]) bindings[platform] = {}
  bindings[platform][arch] = './binding.js'
}

for (const platform of Object.keys(bindings)) bindings[platform].default = './lib/unsupported.js'
bindings.default = './lib/unsupported.js'
pkg.imports = { ...pkg.imports, '#binding': bindings }
fs.writeFileSync(root + '/package.json', JSON.stringify(pkg, null, 2) + '\n')
