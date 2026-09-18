import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function convertWithMacOSImageIO(
  filePath: string,
  format: 'jpeg' | 'png',
): Promise<Buffer> {
  const outputDir = await mkdtemp(join(tmpdir(), 'interpreter-heic-'));
  const outputPath = join(outputDir, `converted.${format === 'jpeg' ? 'jpg' : 'png'}`);

  try {
    const args = ['-s', 'format', format];
    if (format === 'jpeg') {
      args.push('-s', 'formatOptions', '90');
    }
    args.push(filePath, '--out', outputPath);
    await execFileAsync('/usr/bin/sips', args, { timeout: 30_000 });
    return await readFile(outputPath);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function assertNativeHeicConversionAvailable(): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      'HEIC preview requires an operating-system HEIC codec. This build does not bundle a copyleft HEIC decoder.',
    );
  }
}

export async function convertHeicToJpeg(filePath: string): Promise<Buffer> {
  assertNativeHeicConversionAvailable();
  return await convertWithMacOSImageIO(filePath, 'jpeg');
}

export async function convertHeicToPng(filePath: string): Promise<Buffer> {
  assertNativeHeicConversionAvailable();
  return await convertWithMacOSImageIO(filePath, 'png');
}
