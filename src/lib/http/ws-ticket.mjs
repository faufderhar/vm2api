/** Shell tickets stay out of the URL when the browser can send a subprotocol. */

const PREFIX = 'vm2api-ticket.'

export function ticketFromUpgrade(req, url) {
  const query = String(url?.searchParams?.get('ticket') || '').trim()
  if (query) return query
  const offered = String(req?.headers?.['sec-websocket-protocol'] || '')
  for (const part of offered.split(',')) {
    const token = part.trim()
    if (token.startsWith(PREFIX)) return token.slice(PREFIX.length)
  }
  return ''
}

/** Echo the ticket protocol so the browser accepts the handshake. */
export function selectTicketProtocol(protocols) {
  const offered = typeof protocols?.values === 'function' ? [...protocols.values()] : [...(protocols || [])]
  return offered.find((token) => String(token).startsWith(PREFIX)) || false
}
