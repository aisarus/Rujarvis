/**
 * Глаголы разговора и имя их сервера.
 *
 * Отдельным файлом, потому что их читают обе стороны разговора — живая
 * сессия Claude Code (`talkSession.ts`) и ходы Codex (`codexTalk.ts`), — а
 * `talkSession` сам выбирает, кого из них поднять.
 */

/** Имя сервера разговора в конфиге MCP. */
export const TALK_SERVER = 'jarvis-talk';

/**
 * Глаголы разговора.
 *
 * Латиницей — и это не вкусовщина: имена инструментов MCP обязаны попадать в
 * `^[a-zA-Z0-9_.-]{1,64}$`, кириллические отклоняются целиком. Русский живёт в
 * описаниях, которые читает модель.
 */
export const TALK_TOOLS = [
  'start_work',
  'add_note',
  'stop_work',
  'pause_work',
  'resume_work',
  'add_step',
  'work_now',
] as const;

/** Как эти же глаголы называются в `--allowedTools`. */
export const talkToolNames = (): string[] =>
  TALK_TOOLS.map((name) => `mcp__${TALK_SERVER}__${name}`);
