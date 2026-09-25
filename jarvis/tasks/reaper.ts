/**
 * Аварийный выключатель: убить всё, что запустил Джарвис.
 *
 * ## Зачем он нужен отдельно от «стоп»
 *
 * «Стоп» — вежливая просьба: задача её слышит и заканчивается сама. Но если
 * агент завис, ушёл в бесконечный круг или перестал читать свой вход, вежливая
 * просьба не доходит — а человеку нужно, чтобы дошла всегда.
 *
 * Это тот же класс, что «стоп» и «тишина»: обязан срабатывать, когда не
 * работает больше ничего.
 *
 * ## Почему по своим детям, а не по имени программы
 *
 * Соблазн велик: `taskkill /F /IM node.exe` — одна строка. И она снесёт
 * MCP-серверы, чужие сборки, редактор человека и всё остальное, что оказалось
 * на node. Убивать надо ровно то, что запустили мы.
 *
 * Поэтому здесь реестр: каждый порождённый процесс отмечается, каждый
 * завершившийся забывается. Список всегда короткий и всегда наш.
 *
 * ## Почему /T
 *
 * Агент запускается через оболочку, и настоящая работа идёт во внуках: `cmd`
 * → `node` → инструменты. Убить одного родителя значит оставить сирот, которые
 * продолжат жечь процессор и писать в файлы. `/T` валит дерево целиком.
 */
import { spawn } from 'node:child_process';

/** Кого мы запускали и кто ещё жив. */
const свои = new Set<number>();

/** Отметить порождённый процесс. Нулевой и отрицательный pid не бывает. */
export function trackChild(pid: number | undefined): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  свои.add(pid);
}

/** Забыть завершившийся: иначе реестр растёт весь сеанс и мы бьём по пустоте. */
export function forgetChild(pid: number | undefined): void {
  if (typeof pid !== 'number') return;
  свои.delete(pid);
}

/** Сколько процессов под присмотром. */
export function trackedChildren(): number[] {
  return [...свои];
}

export interface ReapResult {
  killed: number[];
  /** Не убитые: уже мертвы или не дались. Разница видна только в журнале. */
  failed: number[];
}

function убитьДерево(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }
  return new Promise((готово) => {
    const тк = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    тк.on('exit', (код) => готово(код === 0));
    тк.on('error', () => готово(false));
  });
}

/**
 * Убить всех своих. Реестр очищается в любом случае: процесс, которого не
 * удалось убить, почти всегда уже мёртв, и держать его в списке — значит
 * бить по нему при каждом следующем «убейся».
 */
export async function reapAll(): Promise<ReapResult> {
  const цели = [...свои];
  свои.clear();

  const killed: number[] = [];
  const failed: number[] = [];
  for (const pid of цели) {
    // По одному, а не пачкой: taskkill с несколькими /PID падает целиком, если
    // хоть один уже мёртв, и тогда выжившие остаются жить.
    if (await убитьДерево(pid)) killed.push(pid);
    else failed.push(pid);
  }
  return { killed, failed };
}
