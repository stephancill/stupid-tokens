export async function cacheKey({ namespace, value }: { namespace: string; value: unknown }) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const key = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return new Request(`https://stupid-tokens-cache.invalid/${namespace}/${key}`);
}

export async function cached<T>({
  namespace,
  key,
  ttl,
  ctx,
  load,
}: {
  namespace: string;
  key: unknown;
  ttl: number;
  ctx: Pick<ExecutionContext, "waitUntil">;
  load: () => Promise<T>;
}): Promise<T> {
  const request = await cacheKey({ namespace, value: key });
  const response = await caches.default.match(request);
  if (response) return response.json<T>();
  const value = await load();
  ctx.waitUntil(
    caches.default.put(
      request,
      Response.json(value, { headers: { "cache-control": `public, max-age=${ttl}` } }),
    ),
  );
  return value;
}
