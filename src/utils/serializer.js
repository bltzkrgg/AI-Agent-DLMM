/**
 * BigInt Safe Serializer
 * Prevents "TypeError: Do not know how to serialize a BigInt"
 */

export function bigIntReplacer(key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function safeStringify(obj, space = 0) {
  try {
    return JSON.stringify(obj, bigIntReplacer, space);
  } catch (e) {
    return String(obj);
  }
}

export function safeParse(str) {
  try {
    return JSON.parse(str, (key, value) => {
      // Basic heuristic to convert back numbers that were strings but might be large
      // Note: This is selective to avoid breaking actual strings
      if (typeof value === 'string' && /^\d+n$/.test(value)) {
        return BigInt(value.slice(0, -1));
      }
      return value;
    });
  } catch {
    return null;
  }
}
