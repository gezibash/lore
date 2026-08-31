export async function mapConcurrent<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1));
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  // Promise.all rejects on the first failure and the results are dropped, so
  // work started after that point is wasted — and a mapper with side effects
  // leaves them behind. Stop handing out items once one has failed.
  let failed = false;
  const workers = Array.from({ length: limit }, async () => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });

  await Promise.all(workers);
  return results;
}
