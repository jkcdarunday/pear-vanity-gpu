'use strict'

// Suggests z32 spellings for prefixes that are not valid z32, so that
// `pear-vanity-gpu holepunch` can offer `ho1epunch`. z32 leaves out l, v, 0
// and 2 (and has no capitals); each missing character maps to lookalikes that
// z32 does have, closest first.
const validation = require('./options')

const ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'

const LOOKALIKES = {
  l: ['1', 'i'],
  v: ['u', 'y'],
  0: ['o'],
  2: ['z']
}

// Returns { capitals, missing, dropped, suggestions }: whether the text has
// capitals, the (lowercased) characters z32 lacks, those with no lookalike
// (left out of suggestions), and up to `limit` valid prefixes, closest first.
module.exports = function suggest(text, limit = 3) {
  const missing = []
  const dropped = []
  let capitals = false
  let candidates = ['']

  for (const char of text) {
    let choices = [char]

    if (!ALPHABET.includes(char)) {
      const lower = char.toLowerCase()

      if (lower !== char) capitals = true

      if (ALPHABET.includes(lower)) {
        choices = [lower]
      } else {
        choices = LOOKALIKES[lower] || []
        if (!missing.includes(lower)) missing.push(lower)
        if (choices.length === 0 && !dropped.includes(lower)) dropped.push(lower)
      }
    }

    if (choices.length === 0) continue

    // Every combination, in order of preference; capped so long inputs stay cheap.
    candidates = candidates.flatMap((prefix) => choices.map((c) => prefix + c)).slice(0, 64)
  }

  const suggestions = []

  for (const candidate of candidates) {
    if (!candidate || candidate === text || suggestions.includes(candidate)) continue

    try {
      validation.prefix(candidate)
    } catch {
      continue
    }

    suggestions.push(candidate)
    if (suggestions.length === limit) break
  }

  return { capitals, missing, dropped, suggestions }
}
