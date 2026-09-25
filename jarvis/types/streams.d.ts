// Минимальные типы для двух потоковых пакетов распаковки моделей: своих
// типов у них нет, а нужны нам три вызова.
declare module 'tar-stream' {
  import type { Readable, Writable } from 'node:stream';
  export interface Headers {
    name: string;
    type?: string;
    mode?: number;
    size?: number;
  }
  export interface Extract extends Writable {
    on(event: 'entry', listener: (header: Headers, stream: Readable, next: () => void) => void): this;
    on(event: 'finish' | 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
  }
  const tar: { extract(): Extract };
  export default tar;
}

declare module 'unbzip2-stream' {
  import type { Transform } from 'node:stream';
  export default function unbzip2Stream(): Transform;
}
