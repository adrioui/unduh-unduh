export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, limit);
  const results = Array.from({ length: items.length }) as R[];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, () => worker()));

  return results;
}
