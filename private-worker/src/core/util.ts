export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Run `fn` over `items` with at most `n` running at the same time. */
export async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!)
    }),
  )
}
