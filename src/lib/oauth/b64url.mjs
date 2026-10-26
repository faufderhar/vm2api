/** Unpadded base64url (RFC 4648 §5), as used for PKCE verifiers, challenges and OAuth state. */
export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
