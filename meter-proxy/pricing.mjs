// pricing.mjs — turn normalised usage into dollars when the upstream did not
// report `usage.cost` itself, using the pinned model's OpenRouter price list.

/** Parse one OpenRouter `/api/v1/models` entry's `pricing` into $/token numbers. */
export function pricingFromModelEntry(entry) {
  const p = entry?.pricing ?? {};
  const n = (v) => {
    const x = Number.parseFloat(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    prompt: n(p.prompt),
    completion: n(p.completion),
    cache_read: n(p.input_cache_read),
    cache_write: n(p.input_cache_write),
  };
}

/**
 * Cost of one call. Cached tokens bill at the cache-read rate when the model
 * lists one (otherwise the full prompt rate), cache-write tokens at the write
 * rate (otherwise the prompt rate). Returns null when the prompt/completion
 * rates are unknown so an unpriced run is never reported as free.
 */
export function computeCost(pricing, usage) {
  if (!pricing || pricing.prompt === null || pricing.completion === null) {
    return null;
  }
  if (usage.prompt_tokens === null || usage.completion_tokens === null) {
    return null;
  }
  const cached = usage.cached_tokens ?? 0;
  const written = usage.cache_write_tokens ?? 0;
  const fresh = Math.max(0, usage.prompt_tokens - cached - written);
  return (
    fresh * pricing.prompt +
    cached * (pricing.cache_read ?? pricing.prompt) +
    written * (pricing.cache_write ?? pricing.prompt) +
    usage.completion_tokens * pricing.completion
  );
}

export async function fetchPricing(upstreamOrigin, model, fetchImpl = fetch) {
  const res = await fetchImpl(`${upstreamOrigin}/api/v1/models`);
  if (!res.ok) throw new Error(`models list: HTTP ${res.status}`);
  const json = await res.json();
  const entry = (json.data ?? []).find((m) => m.id === model);
  if (!entry) throw new Error(`model ${model} not in OpenRouter catalogue`);
  return pricingFromModelEntry(entry);
}
