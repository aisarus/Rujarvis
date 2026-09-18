import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInventoryPath } from './release-license-cli.mjs';

test('accepts an inventory path after the package-manager separator', () => {
  assert.equal(
    resolveInventoryPath(['--', 'production-license-inventory.json'], '/workspace'),
    '/workspace/production-license-inventory.json',
  );
});

test('uses the live package inventory when no path is provided', () => {
  assert.equal(resolveInventoryPath([], '/workspace'), null);
  assert.equal(resolveInventoryPath(['--'], '/workspace'), null);
});
