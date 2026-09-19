/**
 * Запуск MCP-сервера рабочего стола.
 *
 * Отдельный файл, потому что `claude mcp add` запускает именно команду, а не
 * функцию: этот модуль — то, что она вызывает.
 */
import { runDesktopMcpServer } from './mcpServer';

runDesktopMcpServer().catch((error: unknown) => {
  console.error('[jarvis:desktop] сервер не запустился:', error);
  process.exit(1);
});
