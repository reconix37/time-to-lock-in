// Повторные запросы разделяют текущую операцию, а не создают очередь.
export function singleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    pending = Promise.resolve().then(operation).finally(() => { pending = null; });
    return pending;
  };
}
