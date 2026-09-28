import { domainToASCII } from 'node:url';

/**
 * Reduces whatever the caller sent ("https://www.Acme.com/about?x=1", "ACME.com.",
 * "acme.com:443") to the bare host the database is keyed on ("acme.com"), or
 * null if it can't be a real public hostname.
 *
 * Only a leading "www." is stripped. Other subdomains (blog.acme.com) are kept
 * as-is: deciding what the "registrable" domain is needs the public-suffix
 * list, and guessing wrong would merge two different companies into one row.
 */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  host = host.split(/[/?#]/, 1)[0] ?? ''; // path, query, fragment
  host = host.replace(/^[^@]*@/, ''); // user:pass@
  host = host.replace(/:\d+$/, ''); // port
  host = host.replace(/\.+$/, ''); // trailing dot(s)
  host = host.replace(/^www\./, '');
  if (!host) return null;

  // Internationalised names -> punycode, so "bücher.de" and its xn-- form match.
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253) return null;

  const labels = ascii.split('.');
  if (labels.length < 2) return null; // "localhost", "intranet"
  const labelOk = (l: string): boolean => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l);
  if (!labels.every(labelOk)) return null;
  // A TLD is never all digits, which is also what rules out bare IPv4 addresses.
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return null;

  return ascii;
}

/**
 * Every spelling an existing row might plausibly hold for `domain`. Rows that
 * came from the old spreadsheet import may carry "https://www.acme.com/" in
 * metadata.domain rather than the bare host, and a missed match here means a
 * cache miss - i.e. paying to scrape and classify a company we already have.
 * The lookup compares these against lower(metadata->>'domain') and against id.
 */
export function domainLookupVariants(domain: string): string[] {
  const variants = new Set<string>();
  for (const host of [domain, `www.${domain}`]) {
    variants.add(host);
    for (const scheme of ['https://', 'http://']) {
      variants.add(`${scheme}${host}`);
      variants.add(`${scheme}${host}/`);
    }
  }
  return [...variants];
}
