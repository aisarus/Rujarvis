import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

const MAX_ROWS_PER_SHEET = 200;
const MAX_COLUMNS_PER_SHEET = 50;
const MAX_PREVIEW_CHARACTERS = 50_000;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textContent(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('t' in record) return textContent(record.t);
    if ('r' in record) return textContent(record.r);
    if ('#text' in record) return textContent(record['#text']);
  }
  return '';
}

function columnIndexFromReference(reference: string): number {
  const letters = reference.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? '';
  let result = 0;
  for (const character of letters) result = result * 26 + character.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function resolveWorksheetPath(target: string): string {
  const normalizedTarget = target.replace(/^\/+/, '');
  return path.posix.normalize(
    normalizedTarget.startsWith('xl/') ? normalizedTarget : path.posix.join('xl', normalizedTarget),
  );
}

export async function readSpreadsheetTextPreview(filePath: string): Promise<string> {
  if (path.extname(filePath).toLowerCase() === '.xls') {
    throw new Error('Legacy .xls preview requires a compatible document engine. Convert it to .xlsx or use the Excel skill.');
  }

  const zip = await JSZip.loadAsync(await readFile(filePath));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const workbookFile = zip.file('xl/workbook.xml');
  const relationshipsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbookFile || !relationshipsFile) {
    throw new Error('The spreadsheet is missing its workbook metadata.');
  }

  const workbook = parser.parse(await workbookFile.async('string')) as any;
  const relationships = parser.parse(await relationshipsFile.async('string')) as any;
  const relationshipTargets = new Map<string, string>();
  for (const relationship of asArray(relationships?.Relationships?.Relationship)) {
    if (relationship?.Id && relationship?.Target) {
      relationshipTargets.set(String(relationship.Id), String(relationship.Target));
    }
  }

  const sharedStrings: string[] = [];
  const sharedStringsFile = zip.file('xl/sharedStrings.xml');
  if (sharedStringsFile) {
    const parsed = parser.parse(await sharedStringsFile.async('string')) as any;
    for (const item of asArray(parsed?.sst?.si)) sharedStrings.push(textContent(item));
  }

  const sections: string[] = [];
  for (const sheet of asArray(workbook?.workbook?.sheets?.sheet)) {
    const target = relationshipTargets.get(String(sheet?.['r:id'] ?? ''));
    if (!target) continue;
    const worksheetFile = zip.file(resolveWorksheetPath(target));
    if (!worksheetFile) continue;
    const worksheet = parser.parse(await worksheetFile.async('string')) as any;
    const lines: string[] = [];

    for (const row of asArray(worksheet?.worksheet?.sheetData?.row).slice(0, MAX_ROWS_PER_SHEET)) {
      const values: string[] = [];
      for (const cell of asArray(row?.c)) {
        const columnIndex = columnIndexFromReference(String(cell?.r ?? ''));
        if (columnIndex >= MAX_COLUMNS_PER_SHEET) continue;
        while (values.length < columnIndex) values.push('');
        const rawValue = textContent(cell?.v);
        const value = cell?.t === 's'
          ? sharedStrings[Number(rawValue)] ?? ''
          : cell?.t === 'inlineStr'
            ? textContent(cell?.is)
            : rawValue;
        values[columnIndex] = value.replace(/[\t\r\n]+/g, ' ').trim();
      }
      lines.push(values.join('\t').replace(/\t+$/g, ''));
    }

    sections.push(`# ${String(sheet?.name ?? 'Sheet')}\n${lines.join('\n')}`.trim());
    if (sections.join('\n\n').length >= MAX_PREVIEW_CHARACTERS) break;
  }

  const preview = sections.join('\n\n').slice(0, MAX_PREVIEW_CHARACTERS).trim();
  if (!preview) throw new Error('The spreadsheet did not contain readable cell values.');
  return preview;
}
