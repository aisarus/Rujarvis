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
  // Руки на экране (uiHands.ts через мост).
  'screen_overview',
  'switch_to',
  'press_control',
  'open_menu',
  'press_keys',
  'type_text',
  'send_to_claude',
  'claude_waiting',
  'open_claude_session',
  'new_claude_session',
  'open_site',
] as const;

/** Как эти же глаголы называются в `--allowedTools`. */
export const talkToolNames = (): string[] =>
  TALK_TOOLS.map((name) => `mcp__${TALK_SERVER}__${name}`);
