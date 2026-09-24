# Синхронизация с upstream

Rujarvis — форк, а не переписывание. Возможность забирать изменения из
`openinterpreter/interpreter-workstation` — требование продукта, и архитектура
подчинена ему.

## Как устроен форк

Репозиторий содержит полную историю upstream, слитую как самостоятельная ветка
предков. Поэтому обычное слияние работает:

```bash
git remote add upstream https://github.com/openinterpreter/interpreter-workstation.git
git fetch upstream main
git merge upstream/main
```

## Что делает слияние дешёвым

Почти весь код Jarvis лежит в каталоге `jarvis/`, которого в upstream нет.
Новые файлы в новом каталоге не конфликтуют никогда.

Правки в файлах upstream точечные. Их список ниже сверен с
`git diff --diff-filter=M c442320..HEAD` (последний коммит upstream перед
форком — `c442320`); при каждой новой правке upstream-файла таблицу нужно
дополнять.

**Код и сборка:**

| Файл | Изменение | Риск конфликта |
| --- | --- | --- |
| `electron/main.ts` | запуск голосового слоя (`shouldStartJarvis`) после старта приложения | низкий — один блок |
| `shared/types/stt.ts` | элемент `'whisper'` в `STT_BACKENDS`, русские значения по умолчанию | средний — upstream правит этот файл |
| `shared/types/tts.ts` | четыре записи русских голосов, другой `DEFAULT_TTS_MODEL_ID` | низкий — добавление в список |
| `server/configStore.ts` | `isSttBackendSupportedOnWindows` вместо проверки на `'moonshine'` | низкий |
| `server/handlers/stt.ts` | та же проверка платформы | низкий |
| `electron/services/voice-extension.ts` | ветка установки Whisper | средний |
| `server/agentTaskService.ts` | проброс `abortSignal` в headless-задачу | низкий — две строки |
| `src/components/GlobalSettings.tsx` | раздел AI-аккаунтов в настройках | средний |
| `build-electron.mjs` | отдельная сборка MCP-сервера `jarvis/desktop/serve.ts` → `mcp.cjs` | низкий — добавлен в конец |
| `electron/utils/windowsAppConfig.ts` (+ тест) | свой AppUserModelId | низкий |
| `tsconfig.electron.json`, `vitest.config.ts`, `playwright.config.ts` | подключение `jarvis/` | низкий — по строке |
| `package.json`, `pnpm-lock.yaml` | скрипты `jarvis:*`, метаданные форка, убранные официальные релизы | средний — lock-файл решать `pnpm install`, не руками |

**Идентичность и сообщество** — заменены целиком, при слиянии остаётся версия
форка: `README.md` (оригинал — `README.upstream.md`), `product.json`,
`electron-builder.yml` (appId и productName), `SECURITY.md`, `CONTRIBUTING.md`,
`SUPPORT.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `NOTICE`, шаблоны в
`.github/`, `.github/workflows/ci.yml`, `scripts/package-smoke.mjs`.

**Удалено** — официальный и внутренний профили (`distribution/`), их релизные
процессы и деплой веб-рендерера (`.github/workflows/{release,official-release-candidate,internal-release,web-renderer-deploy,website-docs-sync}.yml`,
`scripts/verify-*-release*.mjs`, часть `scripts/ci/`). Если upstream их меняет,
при слиянии выбирать удаление.

Новые файлы в каталогах upstream (`electron/jarvis/`, `server/jarvis/`,
`src/components/settings/AiAccountsSection.tsx`, скрипты `scripts/jarvis-*`,
`scripts/probe-*`) не конфликтуют.

## Порядок при конфликте

1. **Сначала запустить проверки.** `pnpm typecheck`, `pnpm run test:vitest`,
   `pnpm run test:unit` — до того, как разбираться в конфликте руками.
2. **Правила upstream побеждают в файлах upstream.** Если слой Jarvis больше не
   подходит к изменившемуся контракту, менять нужно `jarvis/`, а не
   подстраивать upstream под форк.
3. **Инварианты не обсуждаются.** Нормализация только сужает разрешения;
   исходная реплика всегда доходит до backend'а; классификация риска — чистая
   функция от действия. Слияние, которое их ломает, неправильно слито.
4. **Проверить файлы из таблицы выше поимённо.** Каждый содержит осознанное
   отклонение от upstream, и каждое отклонение прокомментировано на месте.

## Что специально сделано не так, как напрашивалось

**Детекторы CLI не скопированы.** Workstation уже умеет находить и проверять
`claude` и `codex`. Адаптеры Jarvis вызывают его функции через ленивый импорт
вместо второй копии списка путей — копия разошлась бы при первом же обновлении
upstream.

**Распаковка архивов не вынесена из ttsService.** Установщик Whisper использует
те же `tar-stream` и `unbzip2-stream` тем же способом, но своей функцией.
Рефакторинг upstream ради переиспользования создал бы конфликт в файле, который
upstream активно правит.

**Runtime Interpreter инжектируется, а не импортируется.** `InterpreterBackend`
принимает драйвер, поэтому ядро Jarvis не зависит от внутренних модулей
Workstation и тестируется без них. Сам драйвер и сборка ядра лежат в
`server/jarvis/` — это новые файлы в существующем каталоге, а новые файлы не
конфликтуют.
