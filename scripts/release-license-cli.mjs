import path from 'node:path';

export function resolveInventoryPath(args, cwd = process.cwd()) {
  const inventoryArgument = args.find((argument) => argument !== '--');
  return inventoryArgument ? path.resolve(cwd, inventoryArgument) : null;
}
