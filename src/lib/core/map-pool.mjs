/** Map `items` through async `fn` with at most `concurrency` in flight; results keep input order. */
export async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const n = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1))
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}
