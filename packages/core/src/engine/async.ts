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
  // leaves them behind. Stop handing out items once one has failed, and wait
  // for the workers that are still in flight, so a caller that cleans up after
  // a failure sees every side effect the mappers made.
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

  const settled = await Promise.allSettled(workers);
  const rejected = settled.find((outcome) => outcome.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}
