/**
 * Разбор пакета Game State Integration в плоский снимок.
 *
 * ## Почему не отдаём сырой JSON дальше
 *
 * Сырой пакет — это до 209 безымянных объектов в `minimap`, разложенных по
 * ключам `o0`…`o208`, и полтора десятка блоков, четыре из которых всегда
 * пусты. Каждый, кто захочет узнать «кто из врагов рядом», иначе напишет свой
 * фильтр по `image === 'minimap_enemyicon'` — и однажды напишет его неверно.
 *
 * Так и вышло при разведке 21.09.2026: фильтр по `herocircle` не нашёл ни
 * одного врага за всю игру, потому что враги приходят другой иконкой. Вывод
 * «Valve не отдаёт позиции врагов» продержался ровно до того, как прибор
 * проверили. Один разбор в одном месте.
 *
 * ## Что считается союзником
 *
 * Только герой с именем. `minimap_herocircle` приходит и на иллюзии Лансера, и
 * на подконтрольных существ — скелетов Рейдж Кинга за ту игру набралось
 * 389 738 штук. Считать их друзьями значит получить «союзник рядом» там, где
 * ты один, и именно в тот момент, когда это важнее всего.
 */

/** Объект на миникарте: герой, крип, вард, здание. */
export interface MapObject {
  x: number;
  y: number;
  /** Картинка Доты: `minimap_enemyicon`, `minimap_herocircle`, … */
  icon: string;
  /** 2 — radiant, 3 — dire, 4 — нейтралы, 5 — ничьи. */
  team: number;
  /** Имя героя, если объект — герой. */
  hero?: string;
  yaw: number;
  /** Дальность обзора этого объекта. */
  vision: number;
}

export interface SelfHero {
  hero: string;
  level: number;
  alive: boolean;
  /** Здоровье в процентах, 0..100. */
  hp: number;
  x: number;
  y: number;
  buybackCost: number;
  buybackCooldown: number;
}

export interface DotaEvent {
  kind: string;
  gameTime: number;
  /** Разобранное содержимое `data`, если оно было строкой с JSON. */
  data?: Record<string, unknown>;
}

/** Источник обзора: кто-то свой и насколько далеко он видит. */
export interface VisionSource {
  x: number;
  y: number;
  radius: number;
}

/**
 * Пинг на миникарте: телепортация союзника, атака базы, поход в лавку.
 *
 * У пинга телепортации есть живой обратный отсчёт `remainingtime` — по нему
 * видно, сколько секунд до приземления. Такого больше нет нигде в канале.
 */
export interface MapPing {
  kind: string;
  x: number;
  y: number;
  /** Секунд осталось. У телепорта считает от трёх к нулю. */
  remaining: number;
  duration: number;
}

export interface DotaPacket {
  /** Настенное время приёма, миллисекунды. */
  at: number;
  clock: number | null;
  state: string | null;
  matchId: string | null;
  self: SelfHero | null;
  gold: number | null;
  lastHits: number | null;
  deaths: number | null;
  /** 2 — radiant, 3 — dire. Нужна, чтобы отличить свои глаза от чужих. */
  team: number | null;
  enemies: MapObject[];
  allies: MapObject[];
  neutrals: MapObject[];
  /**
   * Все свои источники обзора: герои, крипы, вышки, варды, курьеры.
   *
   * Замер по матчу `9009407694`: если считать видимость только по своему герою,
   * хоть один лагерь виден в 16,7% живого времени и за игру набирается двенадцать
   * разных. Со всеми своими глазами — **95,7% и все шестнадцать**. Разница не в
   * точности, а в том, есть ли прибор вообще.
   */
  vision: VisionSource[];
  pings: MapPing[];
  /**
   * Что лежит у героя: сумка, рюкзак, тайник, телепорт, нейтралка.
   *
   * Имена как в игре, с приставкой: `item_blink`. Пустые слоты приходят именем
   * `empty` и сюда не попадают — иначе «пусто» окажется предметом.
   */
  items: string[];
  events: DotaEvent[];
}

function число(значение: unknown): number | null {
  return typeof значение === 'number' && Number.isFinite(значение) ? значение : null;
}

function объект(сырой: Record<string, unknown>): MapObject | null {
  const x = число(сырой.xpos);
  const y = число(сырой.ypos);
  if (x === null || y === null || typeof сырой.image !== 'string') return null;
  const имя = typeof сырой.name === 'string' && сырой.name.startsWith('npc_dota_hero_')
    ? сырой.name
    : undefined;
  return {
    x,
    y,
    icon: сырой.image,
    team: число(сырой.team) ?? 0,
    hero: имя,
    yaw: число(сырой.yaw) ?? 0,
    vision: число(сырой.visionrange) ?? 0,
  };
}

function события(сырые: unknown): DotaEvent[] {
  if (!Array.isArray(сырые)) return [];
  const итог: DotaEvent[] = [];
  for (const е of сырые) {
    if (!е || typeof е !== 'object') continue;
    const запись = е as Record<string, unknown>;
    const вид = typeof запись.event_type === 'string' ? запись.event_type : null;
    if (!вид) continue;
    let данные: Record<string, unknown> | undefined;
    if (typeof запись.data === 'string') {
      // Дота кладёт сюда строку с JSON: тип чат-сообщения, слоты, время.
      try { данные = JSON.parse(запись.data) as Record<string, unknown>; } catch { данные = undefined; }
    }
    итог.push({ kind: вид, gameTime: число(запись.game_time) ?? 0, data: данные });
  }
  return итог;
}

/**
 * Разобрать сырой пакет. Возвращает `null`, если это не пакет Доты, —
 * бросать нельзя: приёмник не должен падать от мусора на порту.
 */
export function readPacket(сырой: unknown, at: number = Date.now()): DotaPacket | null {
  if (!сырой || typeof сырой !== 'object') return null;
  const пакет = сырой as Record<string, unknown>;

  const геройСырой = (пакет.hero ?? null) as Record<string, unknown> | null;
  const игрок = (пакет.player ?? null) as Record<string, unknown> | null;
  const карта = (пакет.map ?? null) as Record<string, unknown> | null;

  let свой: SelfHero | null = null;
  if (геройСырой && typeof геройСырой.name === 'string') {
    const x = число(геройСырой.xpos);
    const y = число(геройСырой.ypos);
    if (x === null || y === null) return null;
    свой = {
      hero: геройСырой.name,
      level: число(геройСырой.level) ?? 0,
      alive: геройСырой.alive !== false,
      hp: число(геройСырой.health_percent) ?? 0,
      x,
      y,
      buybackCost: число(геройСырой.buyback_cost) ?? 0,
      buybackCooldown: число(геройСырой.buyback_cooldown) ?? 0,
    };
  }

  const команда = игрок && typeof игрок.team_name === 'string'
    ? (игрок.team_name === 'dire' ? 3 : игрок.team_name === 'radiant' ? 2 : null)
    : null;

  const враги: MapObject[] = [];
  const союзники: MapObject[] = [];
  const нейтралы: MapObject[] = [];
  const глаза: VisionSource[] = [];
  const пинги: MapPing[] = [];
  const миникарта = (пакет.minimap ?? null) as Record<string, unknown> | null;
  if (миникарта) {
    for (const сырая of Object.values(миникарта)) {
      if (!сырая || typeof сырая !== 'object') continue;
      const о = объект(сырая as Record<string, unknown>);
      if (!о) continue;
      if (команда !== null && о.team === команда && о.vision > 0) {
        глаза.push({ x: о.x, y: о.y, radius: о.vision });
      }
      if (о.icon.startsWith('minimap_ping_')) {
        const сырьё = сырая as Record<string, unknown>;
        пинги.push({
          kind: о.icon.slice('minimap_ping_'.length),
          x: о.x,
          y: о.y,
          remaining: число(сырьё.remainingtime) ?? 0,
          duration: число(сырьё.eventduration) ?? 0,
        });
      }
      if (о.icon === 'minimap_enemyicon') враги.push(о);
      else if (о.icon === 'minimap_herocircle' && о.hero && о.hero !== свой?.hero) союзники.push(о);
      else if (о.team === 4) нейтралы.push(о);
    }
  }

  const вещи: string[] = [];
  const предметы = (пакет.items ?? null) as Record<string, unknown> | null;
  if (предметы) {
    for (const слот of Object.values(предметы)) {
      if (!слот || typeof слот !== 'object') continue;
      const имя = (слот as Record<string, unknown>).name;
      if (typeof имя === 'string' && имя !== 'empty') вещи.push(имя);
    }
  }

  const снимок: DotaPacket = {
    at,
    clock: карта ? число(карта.clock_time) : null,
    state: карта && typeof карта.game_state === 'string' ? карта.game_state : null,
    matchId: карта && typeof карта.matchid === 'string' ? карта.matchid : null,
    self: свой,
    gold: игрок ? число(игрок.gold) : null,
    lastHits: игрок ? число(игрок.last_hits) : null,
    deaths: игрок ? число(игрок.deaths) : null,
    team: команда,
    enemies: враги,
    allies: союзники,
    neutrals: нейтралы,
    vision: глаза,
    pings: пинги,
    items: вещи,
    events: события(пакет.events),
  };

  // Пакет без героя и без карты — это приветствие из меню, а не игра.
  if (!снимок.self && снимок.clock === null) return null;
  return снимок;
}
