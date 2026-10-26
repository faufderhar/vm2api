/** Split a QEMU option string on single commas; `,,` is a literal comma. */
export function splitQemuOpts(text) {
  const parts = []
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ',' && text[i + 1] === ',') {
      cur += ','
      i++
    } else if (text[i] === ',') {
      parts.push(cur)
      cur = ''
    } else cur += text[i]
  }
  parts.push(cur)
  return parts
}
