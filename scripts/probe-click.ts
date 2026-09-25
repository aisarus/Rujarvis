/**
 * Проверка клика по названию на живом окне.
 *
 * Находит элементы активного окна через дерево доступности и показывает, что
 * выбрал бы подборщик для названных слов. Ничего не нажимает без «--click».
 */

import { chooseElement } from '../jarvis/control/elements';
import { DesktopDriver } from '../jarvis/desktop/driver';

const queries = process.argv.slice(2).filter((arg) => arg !== '--click');
const shouldClick = process.argv.includes('--click');

const driver = new DesktopDriver();

async function main(): Promise<void> {
  const started = Date.now();
  const window = await driver.elements();
  console.log(`окно «${window.title}»: ${window.elements.length} элементов за ${Date.now() - started} мс`);

  for (const element of window.elements.slice(0, 8)) {
    console.log(`  [${element.type}] «${element.name}» id=${element.id} @(${element.x}, ${element.y})`);
  }

  for (const query of queries) {
    const found = chooseElement(query, window.elements);
    if (!found) {
      console.log(`«${query}» → не найдено`);
      continue;
    }
    console.log(`«${query}» → [${found.type}] «${found.name || found.id}» @(${found.x}, ${found.y})`);
    if (shouldClick) {
      await driver.click({ x: found.x, y: found.y });
      console.log('  кликнул');
    }
  }

  driver.dispose();
}

main().catch((error: unknown) => {
  console.error('не удалось:', error);
  driver.dispose();
  process.exit(1);
});
