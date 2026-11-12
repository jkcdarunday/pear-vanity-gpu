'use strict'

// Live search display for the command-line tool, built on bare-tui. It draws on
// stderr's alternate screen, leaving the user's terminal untouched; when it ends
// the caller prints summary() as ordinary lines and the result on stdout.
const tty = require('bare-tty')
const { Program, quit, key, spinner, progress, radio, style } = require('bare-tui')
const { count, duration, label, where } = require('./format')

const faint = style().faint(true)
const warn = style().foreground('yellow')
const good = style().foreground('green').bold(true)
const bad = style().foreground('red').bold(true)

class SearchModel {
  constructor({ prefix, expected, stop }) {
    this.prefix = prefix
    this.expected = expected
    this.stop = stop
    this.started = Date.now()
    this.phase = 'searching'
    this.latest = null
    this.notes = []
    this.width = 80
    this.spinner = spinner.create({ fps: 12 })
    this.bar = progress.create({ width: 40, gradient: ['#5A56E0', '#EE6FF8'] })
  }

  init() {
    return this.spinner.init()
  }

  update(msg) {
    switch (msg.type) {
      case 'spinner.tick': {
        if (this.phase !== 'searching' && this.phase !== 'stopping') return [this, null]
        const [s, cmd] = this.spinner.update(msg)
        this.spinner = s
        return [this, cmd]
      }
      case 'resize':
        this.width = msg.width
        this.bar.setWidth(Math.max(10, Math.min(40, msg.width - 30)))
        return [this, null]
      case 'key':
        if (this.phase === 'searching' && key.matches(msg, 'q', 'esc', 'ctrl+c')) {
          this.phase = 'stopping'
          this.stop()
        }
        return [this, null]
      case 'vanity.progress':
        this.latest = msg.progress
        return [this, null]
      case 'vanity.fallback':
        this.notes.push(`${label(msg.backend)} unavailable: ${msg.message}`)
        return [this, null]
      case 'vanity.end':
        this.phase = msg.phase
        this.seconds = (Date.now() - this.started) / 1000
        return [this, quit]
    }

    return [this, null]
  }

  // Lines to print on the normal screen once the display has closed.
  summary() {
    const lines = this.notes.map((note) => warn.render('! ') + faint.render(note))
    const latest = this.latest
    const tried = latest ? ` · ${count(latest.candidates)} tried` : ''

    if (this.phase === 'found') {
      lines.push(
        good.render('✓ ') +
          `Found ${this.prefix || 'a key'} in ${duration(this.seconds)}` +
          faint.render((latest ? ` on ${where(latest)}` : '') + tried)
      )
    } else if (this.phase === 'stopped') {
      lines.push(bad.render('✗ ') + `Stopped after ${duration(this.seconds)}` + faint.render(tried))
    }

    return lines
  }

  view() {
    const lines = this.notes.map((note) => warn.render('! ') + faint.render(note))
    const latest = this.latest
    const tried = latest ? `${count(latest.candidates)} tried` : ''

    if (this.phase === 'found' || this.phase === 'stopped' || this.phase === 'failed') {
      return lines.join('\n')
    }

    const elapsed = (Date.now() - this.started) / 1000
    lines.push(
      `${this.spinner.view()} ${this.phase === 'stopping' ? 'Stopping' : 'Searching for'} ` +
        style()
          .bold(true)
          .render(this.prefix || '(any)') +
        faint.render(` · expected ${count(this.expected)} candidates`)
    )

    if (!latest) {
      lines.push(faint.render(`  Preparing… ${duration(elapsed)}`))
    } else {
      const rate = latest.candidatesPerSecond
      // Each candidate matches independently, so this is the chance that a
      // search this long would have found a match already.
      const chance = 1 - Math.exp(-latest.candidates / this.expected)

      lines.push(`  ${where(latest)}`)
      lines.push(
        `  ${count(rate)}/s · ${tried} · ${duration(latest.seconds)}` +
          (rate > 0 ? faint.render(` · expected ~${duration(this.expected / rate)}`) : '')
      )
      lines.push(`  ${this.bar.view(chance)} ${faint.render('chance of a match by now')}`)
    }

    lines.push(faint.render('  q to stop'))

    return lines.join('\n')
  }
}

module.exports = class SearchDisplay {
  constructor(options) {
    this.model = new SearchModel(options)
    this.program = new Program(this.model, {
      output: new tty.WriteStream(2),
      fps: 20
    })
    this.running = null
  }

  // Resolves when the display exits, including when a signal from outside
  // closes it; the caller then stops the search.
  start() {
    this.running = this.program.run()
    return this.running
  }

  progress(progress) {
    this.program.send({ type: 'vanity.progress', progress })
  }

  fallback(err) {
    this.program.send({ type: 'vanity.fallback', backend: err.backend, message: err.message })
  }

  // phase: found, stopped or failed. Resolves with the summary lines once the
  // terminal is restored.
  async end(phase) {
    this.program.send({ type: 'vanity.end', phase })
    await this.running
    return this.model.summary()
  }
}

// Picks a z32 spelling for a prefix that is not z32: ↑/↓ and enter, a number
// key, or q/esc/ctrl+c to quit (choice null).
class PrefixModel {
  constructor({ problem, hint, suggestions }) {
    this.problem = problem
    this.hint = hint
    this.suggestions = suggestions
    this.choice = null
    this.width = 80
    this.options = radio
      .create({
        options: [
          ...suggestions.map((value, i) => ({ label: `${i + 1}  ${value}`, value })),
          { label: 'q  Quit', value: null }
        ]
      })
      .focus()
  }

  init() {
    return null
  }

  update(msg) {
    if (msg.type === 'resize') this.width = msg.width
    if (msg.type !== 'key') return [this, null]

    if (key.matches(msg, 'q', 'esc', 'ctrl+c')) return [this, quit]

    if (key.matches(msg, 'enter')) {
      this.choice = this.options.value()
      return [this, quit]
    }

    const number = Number(msg.toString())

    if (Number.isInteger(number) && number >= 1 && number <= this.suggestions.length) {
      this.choice = this.suggestions[number - 1]
      return [this, quit]
    }

    const [options] = this.options.update(msg)
    this.options = options

    return [this, null]
  }

  view() {
    return [
      warn.render('! ') + wrap(this.problem, this.width - 2).join('\n  '),
      '',
      'Search for a z32 spelling instead?',
      '',
      this.options.view(),
      '',
      faint.render('↑/↓ choose · enter confirm · 1–' + this.suggestions.length + ' pick · q quit')
    ].join('\n')
  }
}

// Resolves with the chosen prefix, or null when the user quits.
module.exports.choosePrefix = async function choosePrefix(options, io = {}) {
  const model = new PrefixModel(options)
  const program = new Program(model, { output: io.output || new tty.WriteStream(2), ...io })
  const result = await program.run()

  return result.choice
}

module.exports.PrefixModel = PrefixModel

// bare-tui cuts lines at the screen edge; wrap long messages at spaces instead.
function wrap(text, width) {
  const lines = []
  let line = ''

  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? line + ' ' + word : word
    }
  }

  lines.push(line)

  return lines
}
