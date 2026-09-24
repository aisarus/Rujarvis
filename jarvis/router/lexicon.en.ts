/**
 * English lexicon for the router: the same shape as `lexicon.ru.ts`.
 *
 * Matching is stem-prefix, like the Russian one, so stems here are chosen to
 * be prefixes that do not swallow unrelated words: `tab` would also match
 * `table`, so tabs are recognised by phrase instead.
 *
 * Both lexicons are always active together (`lexicon.ts`). Russian speakers
 * say English technical words all the time, and an English speaker never says
 * a Cyrillic stem by accident, so the union costs nothing.
 */

import type { CapabilityRule } from './lexicon.ru';

export const CAPABILITY_RULES_EN: CapabilityRule[] = [
  {
    capability: 'computer',
    stems: [
      'window', 'minimi', 'maximi', 'mouse', 'cursor', 'keyboard', 'hotkey', 'shortcut',
      'desktop', 'taskbar', 'clipboard', 'scroll', 'drag', 'button', 'icon',
      'draw', 'drawing', 'sketch', 'diagram', 'chart', 'scene', 'sphere', 'cube', 'polygon',
      'texture', 'animat', 'model', 'calculator', 'notepad',
    ],
    phrases: [['open', 'app'], ['close', 'app'], ['switch', 'to']],
  },
  {
    capability: 'vision',
    stems: ['screen', 'screenshot', 'image', 'picture'],
    phrases: [['what', 's', 'on'], ['what', 'is', 'on'], ['look', 'at'], ['what', 'does', 'it', 'say']],
  },
  {
    capability: 'browser',
    stems: ['browser', 'website', 'webpage', 'site', 'page', 'link', 'youtube', 'login', 'sign'],
    phrases: [['new', 'tab'], ['this', 'tab'], ['a', 'tab'], ['sign', 'in'], ['log', 'in']],
  },
  {
    capability: 'coding',
    stems: [
      'code', 'coding', 'compil', 'bug', 'debug', 'crash', 'stack', 'exception', 'project',
      'function', 'class', 'method', 'script', 'depend', 'package', 'refactor', 'repositor',
      'unit', 'typecheck', 'failing',
    ],
    phrases: [["doesn", 't', 'work'], ['not', 'working'], ['won', 't', 'build'], ['does', 'not', 'work']],
  },
  {
    capability: 'files',
    stems: [
      'file', 'folder', 'director', 'download', 'save', 'renam', 'delet', 'move', 'copy',
      'archive', 'document', 'spreadsheet', 'report', 'presentation', 'slide', 'invoice',
      'drive', 'path',
    ],
  },
  {
    capability: 'shell',
    stems: ['command', 'terminal', 'console', 'install', 'reinstall', 'process', 'service', 'port'],
  },
  {
    capability: 'web',
    stems: ['search', 'internet', 'news', 'weather', 'online', 'lookup'],
    phrases: [['look', 'up'], ['find', 'out'], ['what', 'is', 'the', 'latest']],
  },
  {
    capability: 'communication',
    // Not `text`, `chat` or `call`: «translate this text», «chatgpt» and «the
    // function called foo» are not messages to people, and this capability
    // raises the risk class.
    stems: ['send', 'forward', 'message', 'reply', 'email', 'mail'],
    phrases: [['text', 'my'], ['call', 'my'], ['write', 'to'], ['dm']],
  },
  {
    capability: 'system',
    stems: [
      'setting', 'volume', 'brightness', 'bluetooth', 'restart', 'reboot', 'shutdown',
      'sleep', 'battery', 'driver', 'update', 'monitor', 'sound', 'microphone', 'headphone',
    ],
    phrases: [['shut', 'down'], ['turn', 'off', 'the', 'computer']],
  },
  {
    capability: 'creative',
    stems: ['invent', 'compose', 'poem', 'generat', 'slogan', 'idea', 'story', 'imagine'],
  },
  {
    capability: 'memory',
    stems: ['yesterday', 'earlier', 'recent', 'again', 'usual', 'last', 'previous', 'same', 'that', 'those'],
  },
];

export const REFERENTIAL_STEMS_EN = [
  'it', 'this', 'that', 'these', 'those', 'there', 'here', 'same', 'continu',
  'previous', 'last', 'other', 'left', 'right', 'above', 'below',
  // «Why didn't it work?», «what happened?» — about what was just done.
  'happen', 'work', 'went',
];

export const INSPECT_ONLY_PHRASES_EN: string[][] = [
  ['don', 't', 'chang'],
  ['dont', 'chang'],
  ['do', 'not', 'chang'],
  ['don', 't', 'touch'],
  ['don', 't', 'edit'],
  ['don', 't', 'modif'],
  ['don', 't', 'break'],
  ['just', 'look'],
  ['only', 'look'],
  ['just', 'check'],
  ['read', 'only'],
  ['without', 'chang'],
  ['no', 'chang'],
];

export const NO_EXECUTE_PHRASES_EN: string[][] = [
  ['don', 't', 'run'],
  ['dont', 'run'],
  ['do', 'not', 'run'],
  ['don', 't', 'execut'],
  ['don', 't', 'install'],
];

export const LEADING_FILLER_STEMS_EN = ['hey', 'so', 'well', 'okay', 'ok', 'jarvis', 'listen', 'alright'];

export const CONTINUATION_PHRASES_EN: string[][] = [
  ['continu'],
  ['keep', 'going'],
  ['go', 'on'],
  ['carry', 'on'],
  ['what', 'were', 'you', 'doing'],
];

export const EMPHASIS_STEMS_EN = ['fuck', 'shit', 'damn', 'bloody', 'crap'];
