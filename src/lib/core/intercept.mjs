/**
 * Request/response intercept pipeline.
 * Default: no rules → identity (no rewrite).
 *
 * Rule shape:
 * {
 *   id, enabled, phase: 'before_convert'|'before_upstream'|'after_upstream'|'before_client',
 *   match: { path_prefix?, protocol? },
 *   action: { set_header?, remove_header?, set_body_field?, replace_body_json? }
 * }
 */

export function applyIntercept(rules, phase, ctx) {
  if (!rules?.length) return ctx
  let body = ctx.body
  let headers = { ...(ctx.headers || {}) }

  for (const rule of rules) {
    if (rule.enabled === false) continue
    if (rule.phase !== phase) continue
    if (rule.match?.path_prefix && !String(ctx.path || '').startsWith(rule.match.path_prefix)) continue
    if (rule.match?.protocol && rule.match.protocol !== ctx.protocol) continue

    const act = rule.action || {}
    if (act.set_header) {
      for (const [k, v] of Object.entries(act.set_header)) headers[k.toLowerCase()] = v
    }
    if (act.remove_header) {
      for (const k of act.remove_header) delete headers[String(k).toLowerCase()]
    }
    if (act.replace_body_json && typeof act.replace_body_json === 'object') {
      body = act.replace_body_json
    }
    if (act.set_body_field && body && typeof body === 'object') {
      body = { ...body }
      for (const [k, v] of Object.entries(act.set_body_field)) {
        setPath(body, k, v)
      }
    }
  }
  return { ...ctx, body, headers }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Copy-on-write along the dotted path: objects shared with the caller's body are cloned
 * before they change, and a path through __proto__ / constructor / prototype is ignored.
 */
function setPath(obj, path, value) {
  const parts = String(path).split('.')
  if (parts.some((part) => UNSAFE_KEYS.has(part))) return
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]]
    cur[parts[i]] = next != null && typeof next === 'object' ? (Array.isArray(next) ? [...next] : { ...next }) : {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}
