# Rujarvis

**Русскоязычный голосовой AI-ассистент для Windows на базе [Interpreter Workstation](https://github.com/openinterpreter/interpreter-workstation).**

Rujarvis — Windows-first форк Interpreter Workstation. Он не переписывает
Workstation, а добавляет поверх него слой «Джарвис»: русский голосовой UX,
маршрутизацию задач между моделями и подписочные coding-агенты (Claude Code,
Codex), запускаемые через официальные CLI.

Пользователь говорит обычной русской речью — «закрой это окно», «посмотри
почему билд отъебнулся и почини через Клод Код», «а пока открой Telegram» —
и система сама решает, какие возможности и какой backend нужны.

## Что добавляет Rujarvis

| Слой | Каталог | Назначение |
| --- | --- | --- |
| Backends | `jarvis/backends` | `AgentBackend` + адаптеры Claude Code / Codex / Interpreter, fallback-цепочка |
| Router | `jarvis/router` | Определение capabilities, выбор backend, нормализация реплики |
| Risk | `jarvis/risk` | Классы риска SAFE/NORMAL/SENSITIVE/DANGEROUS, политика в коде |
| Memory | `jarvis/memory` | Алиасы проектов, недавние задачи, предпочитаемые приложения |
| Context | `jarvis/context` | World state: активное окно, текущий проект, последняя задача |
| Tasks | `jarvis/tasks` | Foreground/background задачи, пауза, отмена |
| Voice | `jarvis/voice` | Wake word «Джарвис», локальные команды прерывания, spoken/full ответ |

Инфраструктура Workstation (agent runtime, computer-use, браузер, файлы,
shell, skills, permissions, voice pipeline, desktop UI) используется как есть.

## Установка

Windows 11, одна команда в PowerShell:

```powershell
irm https://raw.githubusercontent.com/aisarus/Rujarvis/main/install.ps1 | iex
```

Подробности и ручная сборка — [docs/jarvis/install.md](docs/jarvis/install.md).

## Документация

- [Архитектура Jarvis](docs/jarvis/architecture.md)
- [Голосовой UX и русский язык](docs/jarvis/voice-ru.md)
- [Backends подписочных агентов](docs/jarvis/backends.md)
- [Синхронизация с upstream](docs/jarvis/upstream-sync.md)
- [Статус MVP](docs/jarvis/mvp-status.md)

Документация исходного проекта — в [README.upstream.md](README.upstream.md)
и каталоге `docs/`.

## Лицензия

Apache License 2.0, как и upstream. См. [LICENSE](LICENSE) и [NOTICE](NOTICE).
