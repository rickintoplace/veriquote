/**
 * Tolerant JSON recovery for LLM output. Small models occasionally emit
 * truncated or slightly broken top-level JSON; these helpers recover as many
 * well-formed item objects as possible without ever evaluating code.
 */

/** Return the first balanced `{...}` object in `s`, or `null`. String-aware. */
export function extractFirstJsonObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (start === -1) {
      if (c === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * Return the raw `[...]` array value of `"key"` in possibly-broken JSON text.
 * Falls back to the unterminated tail when the closing bracket is missing.
 */
export function extractArrayByKey(raw: string, key: string): string | null {
  const pos = raw.indexOf(`"${key}"`);
  if (pos === -1) return null;
  const lb = raw.indexOf('[', pos);
  if (lb === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = lb; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return raw.slice(lb, i + 1);
  }
  return raw.slice(lb); // unterminated array: tolerate the tail
}

/** Extract every balanced top-level `{...}` object, skipping junk in between. */
export function extractAllJsonObjects(s: string): string[] {
  const out: string[] = [];
  let rest = s;
  for (;;) {
    const obj = extractFirstJsonObject(rest);
    if (obj === null) return out;
    out.push(obj);
    rest = rest.slice(rest.indexOf(obj) + obj.length);
  }
}

/**
 * Parse `content` (raw LLM output) into an array of item objects.
 * Tries strict parsing of the first JSON object first, then recovers
 * individual items from the `items` array of broken JSON.
 */
export function parseItemsArray(content: string, key = 'items'): unknown[] {
  const objStr = extractFirstJsonObject(content);
  if (objStr) {
    try {
      const parsed: unknown = JSON.parse(objStr);
      const items = (parsed as Record<string, unknown>)?.[key];
      if (Array.isArray(items)) return items;
    } catch {
      // fall through to tolerant recovery
    }
  }
  const arrStr = extractArrayByKey(content, key);
  if (!arrStr) return [];
  const recovered: unknown[] = [];
  for (const one of extractAllJsonObjects(arrStr)) {
    try {
      recovered.push(JSON.parse(one));
    } catch {
      // skip the individual broken item
    }
  }
  return recovered;
}
