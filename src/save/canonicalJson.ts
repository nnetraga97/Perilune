/** Canonical JSON for persistence fingerprints: sorted object keys, stable arrays, no lossy values. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Canonical JSON rejects non-finite numbers');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError(`Canonical JSON rejects ${typeof item} values`);
    if (ancestors.has(item)) throw new TypeError('Canonical JSON rejects cyclic values');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).some((key) => !/^\d+$/.test(key) || Number(key) >= item.length)) {
          throw new TypeError('Canonical JSON rejects non-index array properties');
        }
        const values: string[] = [];
        for (let index = 0; index < item.length; index++) {
          if (!Object.hasOwn(item, index)) throw new TypeError('Canonical JSON rejects sparse arrays');
          values.push(encode(item[index]));
        }
        return `[${values.join(',')}]`;
      }
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => (
        `${JSON.stringify(key)}:${encode(record[key])}`
      )).join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value);
}

export const SAVE_FINGERPRINT_VERSION = 2;
