import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { readSpreadsheetTextPreview } from './spreadsheetText';

describe('readSpreadsheetTextPreview', () => {
  test('extracts shared and inline strings from an xlsx workbook', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-preview-'));
    const workbookPath = path.join(tempDir, 'sample.xlsx');
    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="Report" r:id="rId1"/></sheets></workbook>');
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>');
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Score</t></is></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>');
    await writeFile(workbookPath, await zip.generateAsync({ type: 'nodebuffer' }));

    try {
      expect(await readSpreadsheetTextPreview(workbookPath)).toBe('# Report\nName\tScore\nAda\t42');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
