/**
 * Errors whose message is written for the operator and may be shown as is.
 *
 * The catch-all response hides the text of unexpected faults (paths, SQL,
 * upstream bodies). An error raised on purpose either sets an integer `status`
 * or is made here with `expose: true`, which also keeps its `code`.
 */
export class PublicError extends Error {
  constructor(message, { status = 500, code = 'error', cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'PublicError'
    this.status = Number.isInteger(status) ? status : 500
    this.code = code
    this.expose = true
  }
}

export function publicError(status, code, message) {
  return new PublicError(message, { status, code })
}

export function isExposedError(e) {
  return !!e && typeof e === 'object' && (e.expose === true || Number.isInteger(e.status))
}

// An absolute filesystem path that starts a token (not the path part of a URL).
const ABS_PATH = /(^|[\s'"(=\[,])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g
const STACK_LINE = /\n\s+at\s.*$/gs

/**
 * Text of an error for an authenticated operator response: the message itself,
 * without stack frames or absolute filesystem paths, bounded in length.
 */
export function operatorErrorMessage(e, { max = 500 } = {}) {
  const raw = String((e && typeof e === 'object' ? e.message : e) || e || 'error')
  const clean = raw.replace(STACK_LINE, '').replace(ABS_PATH, '$1<path>')
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}
