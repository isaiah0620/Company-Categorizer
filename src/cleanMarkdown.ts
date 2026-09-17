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
