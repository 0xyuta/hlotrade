/**
 * Runs `fn` over `items`, at most `limit` at a time. The first failure is rejected after the ones already running have
 * finished (so nothing runs on in the background once the caller has the error), and no further item is started.
 */
export async function forEachLimit<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  if (!(limit >= 1)) throw new RangeError(`forEachLimit: limit ${limit} is below 1`);
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (next < items.length && errors.length === 0) {
      const x = items[next++];
      try {
        await fn(x);
      } catch (e) {
        errors.push(e);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length > 0) throw errors[0];
}
