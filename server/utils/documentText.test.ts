import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readDocxText } from './documentText';

test('readDocxText extracts readable text for internal previews', async () => {
  const fixture = path.join(
    process.cwd(),
    'resources',
    'sample-workspace',
    'Demos',
    'Fill PDF Form',
    'Vendor Information.docx',
  );
  const text = await readDocxText(await readFile(fixture));

  expect(text.length).toBeGreaterThan(50);
  expect(text.toLowerCase()).toContain('vendor');
});
