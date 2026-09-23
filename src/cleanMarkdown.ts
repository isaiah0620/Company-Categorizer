/**
 * Direct port of the n8n "Code in JavaScript2" node: strips inline SVGs,
 * base64/data-URI images, and bare data URIs out of scraped markdown so the
 * LLM prompt isn't bloated with unusable binary blobs.
 */
export function stripImages(text: string | undefined | null): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';

  let out = text;

  // Markdown images pointing at a data: URI (svg+xml, png, jpeg, etc.)
  out = out.replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/gi, '');

  // Raw <svg>...</svg> blocks (can be huge / multi-line)
  out = out.replace(/<svg[\s\S]*?<\/svg>/gi, '');

  // <img ... src="data:..."> tags
  out = out.replace(/<img\b[^>]*\bsrc=["']data:[^"']*["'][^>]*>/gi, '');

  // Any leftover bare data URIs
  out = out.replace(
    /data:image\/[a-zA-Z0-9+.\-]+;(?:base64|utf8|charset=[^,]*),[^\s)"'<>]*/gi,
    ''
  );

  // Collapse excess blank lines, trim trailing whitespace per line
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}

/* ------------------------------------------------------------------ */
/* Token-budget trimming                                               */
/* ------------------------------------------------------------------ */

/**
 * Hard ceiling on what is sent to the model per company. ~4 chars per token
 * for English, so 12,000 chars is roughly 3,000 tokens. Raise it if the
 * classifications start losing accuracy; lower it to save more.
 */
export const MAX_MARKDOWN_CHARS = 12_000;

/** Lines that are almost always navigation, legal, or consent boilerplate. */
const BOILERPLATE_LINE =
  /^\s*(?:[-*]\s*)?(?:skip to (?:main )?content|accept (?:all )?cookies?|cookie (?:settings|policy|preferences)|privacy policy|terms (?:of (?:use|service)|& conditions)|all rights reserved|©|copyright\s*©?|sign in|log in|login|subscribe|follow us|back to top)\b.*$/i;

/**
 * Shrinks scraped markdown to what the classifier can actually use:
 *  - links keep their text, lose their URLs (URLs tokenise badly)
 *  - remaining images (alt text only) are dropped
 *  - bare URLs, nav/footer boilerplate and repeated lines are dropped
 *  - result is capped at MAX_MARKDOWN_CHARS, cut on a paragraph boundary
 *
 * Run AFTER stripImages().
 */
export function compactForModel(text: string, maxChars: number = MAX_MARKDOWN_CHARS): string {
  if (!text) return '';

  let out = text;

  // ![alt](url) -> nothing (alt text on logos/icons is noise)
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // [label](url) -> label
  out = out.replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  // bare URLs
  out = out.replace(/https?:\/\/[^\s)>\]]+/gi, '');

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.replace(/[ \t]+/g, ' ').trim();
    if (line === '') {
      kept.push('');
      continue;
    }
    if (BOILERPLATE_LINE.test(line)) continue;
    // Skip lines with no letters at all (separators, stray bullets, ```).
    if (!/[A-Za-z]/.test(line)) continue;
    // Repeated menu items / footer links: keep the first occurrence only.
    // Long lines are real prose, so only dedupe short ones.
    if (line.length <= 80) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(line);
  }

  out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  if (out.length <= maxChars) return out;

  // Keep the head: hero copy, "About", and "What we do" sit at the top.
  const slice = out.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
  return (cut > maxChars * 0.7 ? slice.slice(0, cut) : slice).trim();
}