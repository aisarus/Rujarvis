import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBinaryName,
  getPlatformKey,
  shouldBuildQwenAsr,
} from './download-qwen-asr.mjs';

test('qwen-asr builds only on the platforms packaged with qwen voice assets', () => {
  assert.equal(shouldBuildQwenAsr('darwin', 'arm64'), true);
  assert.equal(shouldBuildQwenAsr('darwin', 'x64'), true);
  assert.equal(shouldBuildQwenAsr('linux', 'arm64'), true);
  assert.equal(shouldBuildQwenAsr('linux', 'x64'), true);
  assert.equal(shouldBuildQwenAsr('win32', 'arm64'), false);
  assert.equal(shouldBuildQwenAsr('win32', 'x64'), false);
});

test('qwen-asr keeps platform directory and executable naming stable', () => {
  assert.equal(getPlatformKey('win32', 'x64'), 'win32-x64');
  assert.equal(getPlatformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(getBinaryName('win32'), 'qwen_asr.exe');
  assert.equal(getBinaryName('linux'), 'qwen_asr');
});
