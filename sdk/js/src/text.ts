// Text helpers ported from the device (src/node/text.js), with the same results.

function limit(s: string, maxLength: number): string {
  return s.length > maxLength ? s.slice(0, maxLength).trim() : s;
}

/**
 * A track or clip name as the device makes it: letters and digits of any language, space and
 * `_ - ( ) . ' & + # !`. Anything else becomes a space, and the name is cut at maxLength.
 */
export function cleanName(name: unknown, fallback: string, maxLength = 60): string {
  const s = String(name == null ? '' : name)
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _\-().'&+#!]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limit(s, maxLength) || fallback;
}

/** 1693484 -> "1.6 MB", 210763776 -> "201 MB", as the device writes sizes. */
export function megabytes(bytes: number): string {
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';
}
