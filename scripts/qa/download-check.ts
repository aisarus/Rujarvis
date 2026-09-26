/**
 * Живая проверка: загрузка модели переживает обрыв связи.
 *
 * Настоящий архив голоса (Ирина, 67 МБ) с настоящего сервера моделей — во
 * временную папку. Первая попытка обрывается принудительно на восьмом
 * мегабайте. Прошло — если следующая попросила продолжение с места обрыва
 * (`Range`), сервер ответил 206, архив распаковался, а по сети не пришлось
 * качать его заново целиком.
 *
 * Модульные тесты (`modelDownload.vitest.test.ts`) ведут себя как сервер
 * релизов по замеру, но замер — не сервер. Здесь настоящий, с его
 * переадресацией на хранилище.
 *
 * Три ответа: прошло, не прошло, нечем мерить (нет сети до первого байта).
 * На обеих системах: окон не трогает, только сеть и временная папка.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installArchive } from '../../jarvis/voice/modelArchive';
import { getVoice, isVoiceInstalled } from '../../jarvis/voice/tts';

const ГОЛОС = 'vits-piper-ru_RU-irina-medium';
const ОБРЫВ = 8 * 1024 * 1024;

async function main(): Promise<void> {
  const голос = getVoice(ГОЛОС);
  const корень = mkdtempSync(path.join(os.tmpdir(), 'jarvis-download-check-'));
  const запросы: Array<{ range: string; статус: number }> = [];
  let поСети = 0;
  let первыйБайт = false;

  const сОбрывом = (async (url: string | URL | Request, init?: RequestInit) => {
    const номер = запросы.length + 1;
    const ответ = await fetch(url, init);
    запросы.push({ range: new Headers(init?.headers).get('range') ?? '', статус: ответ.status });
    if (!ответ.body) return ответ;
    const читатель = ответ.body.getReader();
    let отдано = 0;
    const тело = new ReadableStream<Uint8Array>({
      async pull(поток) {
        if (номер === 1 && отдано >= ОБРЫВ) {
          await читатель.cancel().catch(() => undefined);
          поток.error(new Error('принудительный обрыв'));
          return;
        }
        const { done, value } = await читатель.read();
        if (done) {
          поток.close();
          return;
        }
        первыйБайт = true;
        отдано += value.length;
        поСети += value.length;
        поток.enqueue(value);
      },
      cancel: (причина) => читатель.cancel(причина),
    });
    return new Response(тело, { status: ответ.status, headers: ответ.headers });
  }) as typeof fetch;

  let итог: { вид: 'прошло' | 'не прошло' | 'нечем мерить'; что: string };
  try {
    await installArchive({
      url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${голос.id}.tar.bz2`,
      installRoot: корень,
      rootDirName: голос.id,
      expectedBytes: голос.downloadBytes,
      isInstalled: async () => isVoiceInstalled(корень, голос.id),
      fetchImpl: сОбрывом,
      retryDelayMs: () => 500,
    });
    const второй = запросы[1];
    const с = Number(/bytes=(\d+)-/u.exec(второй?.range ?? '')?.[1] ?? 0);
    итог = !второй
      ? { вид: 'не прошло', что: 'обрыв не вызвал второй попытки' }
      : с < ОБРЫВ * 0.9
        ? { вид: 'не прошло', что: `вторая попытка начала с ${с} байт, а оборвалось на ${ОБРЫВ}` }
        : второй.статус !== 206
          ? { вид: 'не прошло', что: `на продолжение сервер ответил ${второй.статус}, а не 206` }
          : !isVoiceInstalled(корень, голос.id)
            ? { вид: 'не прошло', что: 'после загрузки голоса нет на месте' }
            : поСети > голос.downloadBytes * 1.2
              ? { вид: 'не прошло', что: `по сети пришло ${поСети} байт — архив качался заново` }
              : { вид: 'прошло', что: `обрыв на ${ОБРЫВ}, продолжение с ${с} (206), по сети ${поСети} из ${голос.downloadBytes}` };
  } catch (беда) {
    const текст = беда instanceof Error ? беда.message : String(беда);
    итог = первыйБайт ? { вид: 'не прошло', что: текст } : { вид: 'нечем мерить', что: `нет сети до первого байта: ${текст}` };
  } finally {
    rmSync(корень, { recursive: true, force: true });
  }

  console.log('');
  console.log('Загрузка модели переживает обрыв');
  console.log(`  запросы: ${запросы.map((з) => `${з.статус} ${з.range || '(с начала)'}`).join('; ')}`);
  console.log(`  ${итог.вид === 'прошло' ? 'прошло      ' : итог.вид === 'не прошло' ? 'НЕ ПРОШЛО   ' : 'нечем мерить'} ${итог.что}`);
  console.log(`Всего 1: ${итог.вид}`);
  process.exit(итог.вид === 'прошло' ? 0 : итог.вид === 'не прошло' ? 1 : 2);
}

void main();
