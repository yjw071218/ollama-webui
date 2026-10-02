// Bound concurrent reads/transfers: large cards can contain thousands of assets.
// Wait for every worker before rejecting so a retry cannot overlap old writes.
export async function syncAssetTasks(items, task, progress = () => {}, concurrency = 8) {
  let next = 0, completed = 0, failure;
  const worker = async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        await task(items[index], index);
        progress(++completed, items.length);
      } catch (error) { failure ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failure) throw failure;
}
