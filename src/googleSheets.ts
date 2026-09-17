import { google, sheets_v4 } from 'googleapis';
import { config } from './config.js';
import type { SheetRow, SheetUpdateFields } from './types.js';

const RANGE = `${config.google.sheetName}`;

let sheetsClient: sheets_v4.Sheets | null = null;

async function getClient(): Promise<sheets_v4.Sheets> {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.JWT({
    email: config.google.clientEmail,
    key: config.google.privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  await auth.authorize();
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

/**
 * Reads the whole sheet and returns an array of row objects keyed by header,
 * plus the 1-based sheet row number (accounting for the header row) so we
 * can target updates precisely.
 */
export async function getRows(): Promise<SheetRow[]> {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.spreadsheetId,
    range: RANGE,
  });

  const [header, ...rows] = res.data.values ?? [];
  if (!header) return [];

  return rows.map((row, idx): SheetRow => {
    const obj: SheetRow = { __rowNumber: idx + 2 }; // +2: 1-based, plus header row
    header.forEach((col: string, i: number) => {
      obj[col] = row[i] ?? '';
    });
    return obj;
  });
}

/**
 * Equivalent of the n8n "Update row in sheet" nodes: matches on the Domains
 * column and writes the given fields into that row. Columns not present in
 * `fields` are left untouched.
 */
export async function updateRowByDomain(
  domain: string,
  fields: SheetUpdateFields
): Promise<void> {
  const sheets = await getClient();

  // Re-fetch header + rows to find the matching row and column indices.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.spreadsheetId,
    range: RANGE,
  });
  const [header, ...rows] = res.data.values ?? [];
  if (!header) throw new Error('Sheet has no header row');

  const domainColIdx = header.indexOf('Domains');
  if (domainColIdx === -1) throw new Error('Sheet has no "Domains" column');

  const rowIdx = rows.findIndex((r: string[]) => r[domainColIdx] === domain);
  if (rowIdx === -1) {
    console.warn(`[googleSheets] No row found for domain "${domain}", skipping update.`);
    return;
  }
  const sheetRowNumber = rowIdx + 2;

  const requests = Object.entries(fields)
    .map(([col, value]) => {
      const colIdx = header.indexOf(col);
      if (colIdx === -1) {
        console.warn(`[googleSheets] Column "${col}" not found in sheet header, skipping.`);
        return null;
      }
      const colLetter = columnIndexToLetter(colIdx);
      return {
        range: `${config.google.sheetName}!${colLetter}${sheetRowNumber}`,
        values: [[String(value ?? '')]],
      };
    })
    .filter((req): req is { range: string; values: string[][] } => req !== null);

  if (requests.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.google.spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: requests,
    },
  });
}

function columnIndexToLetter(idx: number): string {
  let letter = '';
  let n = idx;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}
