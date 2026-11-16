/** Build a reusable log scrubber; keep it self-contained for the sandbox module. */
export function createRedactor(secrets) {
  const replacements = Object.entries(secrets).flatMap(([name, value]) => {
    const bytes = new TextEncoder().encode(value);
    const base64 = btoa(String.fromCharCode(...bytes));
    const url64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const patterns = [value, encodeURIComponent(new TextDecoder().decode(bytes)), base64, url64];
    // Serialization escapes quotes/control characters before the log sink sees
    // them. Scrub both representations before applying any excerpt size limit.
    return [...new Set(patterns.flatMap(pattern => [pattern, JSON.stringify(pattern).slice(1, -1)]))].filter(Boolean).map(pattern => ({ pattern, name }));
  }).sort((a, b) => b.pattern.length - a.pattern.length);
  return text => {
    let result = String(text);
    for (const { pattern, name } of replacements) result = result.split(pattern).join(`«secret:${name}»`);
    return result;
  };
}
