/**
 * Программы на маке голосом: «открой калькулятор», «закрой калькулятор».
 *
 * До 27.09.2026 на маке «открой хром» звал cmd.exe и отвечал «Не смог
 * открыть», список установленного был пуст («Windows не ответил про
 * магазин»), а «закрой» уходил агенту. Здесь — тот же путь, что у голоса:
 * фраза → таблица запуска → `launchOnMac` → программа запущена →
 * `quitAndWait` → вышла. Плюс список установленного и честный отказ на
 * несуществующей программе.
 *
 * Калькулятор, а не TextEdit: у него нет документов, и штатный выход не
 * упирается в «Сохранить?». Открывает окно — поэтому гоняется в CI.
 * Только мак: на Windows этот путь — `start` и `taskkill`, их меряет
 * hands-check; здесь выходит с кодом 2.
 *
 * Три ответа: прошло, не прошло, нечем мерить.
 */
import { listInstalledPrograms } from '../../jarvis/apps/installed';
import { aliasTarget, matchAppLaunch } from '../../jarvis/apps/launch';
import { isMacAppRunning, launchOnMac, macAppName, quitAndWait } from '../../jarvis/apps/macApps';

type Итог = { вид: 'прошло' | 'не прошло' | 'нечем мерить'; что: string };

const подождать = (мс: number): Promise<void> => new Promise((готово) => setTimeout(готово, мс));

async function main(): Promise<void> {
  console.log('');
  console.log('Программы на маке: открыть, увидеть, закрыть');
  if (process.platform !== 'darwin') {
    console.log('НЕЧЕМ МЕРИТЬ: проверка для мака; на Windows запуск и закрытие меряет hands-check');
    process.exit(2);
  }

  const итоги: Array<{ имя: string; итог: Итог }> = [];
  const шаг = async (имя: string, делать: () => Promise<Итог>): Promise<void> => {
    try {
      итоги.push({ имя, итог: await делать() });
    } catch (беда) {
      итоги.push({ имя, итог: { вид: 'не прошло', что: (беда instanceof Error ? беда.message : String(беда)).slice(0, 240) } });
    }
  };

  await шаг('список установленного — папки программ', async () => {
    const список = await listInstalledPrograms();
    const имена = список.programs.map((p) => p.name);
    const нужные = ['Calculator', 'TextEdit'].filter((n) => !имена.includes(n));
    return нужные.length === 0 && список.полный
      ? { вид: 'прошло', что: `${имена.length} программ, среди них Calculator и TextEdit` }
      : { вид: 'не прошло', что: `нет: ${нужные.join(', ') || '—'}; полный: ${список.полный}` };
  });

  const запуск = matchAppLaunch('открой калькулятор');
  const имя = macAppName(aliasTarget('калькулятор') ?? '') ?? '';
  await шаг('«открой калькулятор» — программа запущена', async () => {
    if (!запуск) return { вид: 'не прошло', что: 'фраза не разобралась как запуск' };
    await launchOnMac(запуск.target, 'path');
    for (let i = 0; i < 25; i += 1) {
      if (await isMacAppRunning(имя)) return { вид: 'прошло', что: `${запуск.target} → ${имя}` };
      await подождать(400);
    }
    return { вид: 'не прошло', что: `${имя} не появился среди запущенных за 10 с` };
  });

  await шаг('«закрой калькулятор» — вышел штатно', async () => {
    if (!(await isMacAppRunning(имя))) return { вид: 'нечем мерить', что: 'закрывать нечего: не запустился' };
    return (await quitAndWait(имя, 8_000))
      ? { вид: 'прошло', что: `${имя} вышел через меню` }
      : { вид: 'не прошло', что: `${имя} всё ещё запущен` };
  });

  await шаг('несуществующая программа — честный отказ, а не «Открываю»', async () => {
    try {
      await launchOnMac('Программа-которой-нет-12345', 'path');
    } catch (беда) {
      return { вид: 'прошло', что: (беда instanceof Error ? беда.message : String(беда)).slice(0, 100) };
    }
    return { вид: 'не прошло', что: 'open сказал, что открыл несуществующее' };
  });

  let неПрошло = 0;
  let нечем = 0;
  for (const { имя: название, итог } of итоги) {
    if (итог.вид === 'не прошло') неПрошло++;
    if (итог.вид === 'нечем мерить') нечем++;
    const метка = итог.вид === 'прошло' ? 'прошло      ' : итог.вид === 'не прошло' ? 'НЕ ПРОШЛО   ' : 'нечем мерить';
    console.log(`  ${метка} ${название} — ${итог.что}`);
  }
  console.log(`Всего ${итоги.length}: не прошло ${неПрошло}, нечем мерить ${нечем}`);
  process.exit(неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0);
}

void main();
