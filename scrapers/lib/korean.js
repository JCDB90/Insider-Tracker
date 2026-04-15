'use strict';

/**
 * Korean name romanization helper.
 *
 * Converts Hangul (Korean) insider names to Revised Romanization for display
 * to non-Korean readers.
 *
 * Strategy:
 *   - Personal names (≤4 Hangul chars): split as Surname + GivenName
 *     e.g. 김성수 → "Gim Seongssu", 얀손헨릭 → "Yanson Henrig"
 *   - Corporate / institutional names (5+ Hangul chars): capitalize full romanization
 *     e.g. 국민연금공단 → "Gugminyeongeumgongdan"
 *   - Non-Hangul input: returned unchanged
 */

let rom;
try {
  rom = require('hangul-romanization');
} catch {
  rom = null;
}

/**
 * Capitalize first letter, lowercase the rest.
 * @param {string} s
 * @returns {string}
 */
function cap(s) {
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1);
}

/**
 * Romanize a Korean name to Revised Romanization.
 * Returns the original string if no Hangul is detected or the library is unavailable.
 *
 * @param {string|null} name
 * @returns {string|null}
 */
function romanizeKoreanName(name) {
  if (!name || typeof name !== 'string') return name;
  if (!rom) return name;                          // library not installed

  // Only process names that contain Hangul
  if (!/[\uAC00-\uD7AF]/.test(name)) return name;

  // Extract just the Hangul characters (skip parentheses, spaces, Latin letters)
  const hangulChars = [...name].filter(c => /[\uAC00-\uD7AF]/.test(c));
  if (hangulChars.length === 0) return name;

  if (hangulChars.length <= 4) {
    // Personal name: first Hangul char = surname, rest = given name
    const surname  = rom.convert(hangulChars[0]);
    const givenRaw = hangulChars.slice(1).join('');
    const given    = givenRaw ? rom.convert(givenRaw) : '';
    return given ? `${cap(surname)} ${cap(given)}` : cap(surname);
  } else {
    // Corporate / long name: romanize everything as one token
    return cap(rom.convert(hangulChars.join('')));
  }
}

module.exports = { romanizeKoreanName };
