'use strict'
// Chat's times (RFC 3339 strings) compared at full precision (design "Read state": Chat compares
// exactly, so a read time 1 µs before a message leaves it unread). A `Date` keeps milliseconds only:
// `2026-11-03T08:00:00.123456Z` and `...123999Z` would be equal there and the 1 µs mark unread would
// vanish. So a time is parsed to nanoseconds since the epoch as a BigInt (Chat sends at most
// microseconds today; nanoseconds cost nothing more), and written back with all its digits.
// (The old connector's `ts` / `after`, which padded the fraction to Python's 6 digits.)

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})$/

/** Nanoseconds since the epoch of an RFC 3339 time, or null for anything else (empty included). */
function parse(s) {
  if (typeof s !== 'string' || s.length > 40) return null
  const m = RFC3339.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, se, frac, zone] = m
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
  if (!Number.isFinite(ms)) return null
  let offsetMin = 0
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1
    offsetMin = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
  }
  const nanosFrac = BigInt((frac || '').padEnd(9, '0') || '0')
  return (BigInt(ms) - BigInt(offsetMin) * 60000n) * 1000000n + nanosFrac
}

/** Milliseconds since the epoch (for ages and sorting), 0 when not a time. */
function ms(s) {
  const n = parse(s)
  return n === null ? 0 : Number(n / 1000000n)
}

/**
 * Whether a message at `t` is new after the read time `last`: compared parsed. No read time (never
 * read, or not known) counts every message as new, as Chat does.
 */
function after(t, last) {
  const a = parse(t)
  if (a === null) return false
  const b = parse(last)
  return b === null || a > b
}

/** `a` compared with `b`: -1, 0, 1 (an unparseable time sorts first). */
function compare(a, b) {
  const x = parse(a)
  const y = parse(b)
  if (x === y) return 0
  if (x === null) return -1
  if (y === null) return 1
  return x < y ? -1 : 1
}

/** A time in nanoseconds as RFC 3339 UTC, with the fraction Chat needs (6 digits, 9 when finer). */
function format(nanos) {
  let n = BigInt(nanos)
  if (n < 0n) n = 0n // nothing Chat sends is before 1970; a 1970 "never" stays 1970
  const secs = n / 1000000000n
  const nine = (n % 1000000000n).toString().padStart(9, '0')
  const base = new Date(Number(secs) * 1000).toISOString().slice(0, 19)
  return `${base}.${nine.endsWith('000') ? nine.slice(0, 6) : nine}Z`
}

/** The time 1 µs before `t` (mark unread: Chat shows the message at `t` unread), null when `t` is not one. */
function justBefore(t) {
  const n = parse(t)
  return n === null ? null : format(n - 1000n)
}

/** `t` as RFC 3339 UTC with its full precision (a time Google wrote with an offset, normalised). */
function normalise(t) {
  const n = parse(t)
  return n === null ? null : format(n)
}

/**
 * An RFC 3339 time of a Date / ms value, whole seconds (rounded down): a search window's start.
 * Chat's `messages:search` refuses a fractional time ("Invalid filter query" on
 * `createTime >= "...28.590000Z"`, seen 2026-11-03); its docs only show whole seconds.
 */
function fromMs(value) {
  return new Date(Math.floor(value / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
}

/** Whether `t` is Google's "never" (the 1970 epoch a thread the person does not follow answers). */
function isEpoch(t) {
  const n = parse(t)
  return n === null || n <= 0n
}

module.exports = { parse, ms, after, compare, format, justBefore, normalise, fromMs, isEpoch }
