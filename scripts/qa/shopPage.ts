/**
 * Страница-магазин для живых проверок браузера: поле поиска, кнопка,
 * результаты появляются через полторы секунды, как на живом сайте.
 *
 * Общая для `browse-check` (цепочка инструментов, CI) и `browse-agent-check`
 * (агент целиком, у владельца): обе проверки обязаны мерить одно и то же.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Что на странице найдётся по запросу «ноутбук»: название и цена. */
export const НОУТБУКИ: ReadonlyArray<readonly [string, number]> = [
  ['Ноутбук Лёгкий', 54990],
  ['Ноутбук Мощный', 129990],
  ['Ноутбук Школьный', 32990],
];

/** Что есть на странице, но по «ноутбуку» найтись не должно. */
export const ЛИШНЕЕ: ReadonlyArray<readonly [string, number]> = [
  ['Мышь беспроводная', 1490],
  ['Клавиатура тихая', 2990],
];

const СТРАНИЦА = [
  '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Проба поиска Джарвиса</title></head><body>',
  '<main>',
  '<h1>Магазин пробы</h1>',
  '<form id="f"><label for="q">Поиск товаров</label>',
  '<input id="q" name="q" placeholder="Поиск товаров"><button type="submit">Найти</button></form>',
  '<p id="itog"></p>',
  '<table id="t"></table>',
  '</main>',
  '<script>',
  `var goods = ${JSON.stringify([...НОУТБУКИ, ...ЛИШНЕЕ])};`,
  'document.getElementById("f").addEventListener("submit", function (e) {',
  '  e.preventDefault();',
  '  var q = document.getElementById("q").value.trim().toLowerCase();',
  '  setTimeout(function () {',
  '    var found = goods.filter(function (g) { return g[0].toLowerCase().indexOf(q) >= 0; });',
  '    document.getElementById("t").innerHTML = found.map(function (g) {',
  '      return "<tr><td>" + g[0] + "</td><td>" + g[1] + " руб.</td></tr>"; }).join("");',
  '    document.getElementById("itog").textContent = "Найдено: " + found.length;',
  '  }, 1500);',
  '});',
  '</script></body></html>',
].join('');

/** Поднять страницу на 127.0.0.1 со случайным портом. */
export async function поднятьМагазин(): Promise<{ адрес: string; закрыть(): void }> {
  const http = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(СТРАНИЦА);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    адрес: `http://127.0.0.1:${(http.address() as AddressInfo).port}/`,
    закрыть: () => http.close(),
  };
}
