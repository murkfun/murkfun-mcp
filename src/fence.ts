// Third-party text shown to the model: tool results and error messages alike.

const MAX_UNTRUSTED = { symbol: 16, name: 64 } as Record<string, number>;
/** Control and format characters (zero-width, bidi overrides), and the fence characters themselves. */
const STRIP = /[\p{Cc}\p{Cf}«»]/gu;

/** «text», control / format characters removed, at most 16 (symbol), 64 (name) or 300 characters, so the model reads
 *  it as data, not as instructions. */
export function fence(key: string, s: string): string {
  const max = MAX_UNTRUSTED[key] ?? 300;
  const clean = s.replace(STRIP, "");
  return `«${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}»`;
}
