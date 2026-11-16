const encoder = new TextEncoder();
/** Bound the complete JSON log, including UTF-8 and escaping overhead. */
export function boundLog(result, maxBytes = 15000) {
  const output = { ...result };
  while (encoder.encode(JSON.stringify(output)).length > maxBytes) {
    const field = Object.keys(output).filter(key => typeof output[key] === 'string' && key !== 'status').sort((a, b) => output[b].length - output[a].length)[0];
    if (!field) break;
    output[field] = output[field].slice(0, Math.floor(output[field].length / 2));
    output.truncated = true;
  }
  return output;
}
