/**
 * Сплошная запись лекции → куски для распознавания.
 *
 * Микрофон отдаёт звук ровным потоком по секунде, тишину тоже. Здесь он
 * копится и режется в паузах (`cutAtPause`): кусок не длиннее окна Whisper и
 * не рвёт слово на стыке. Ничего не выбрасывается — склеенные куски дают ровно
 * ту запись, что пришла, поэтому метка времени куска совпадает с местом в WAV.
 */

import { cutAtPause, LIVE_CUT, type CutOptions } from './audioCut';

export class LectureRecorder {
  private части: Float32Array[] = [];
  private отсчётов = 0;
  private частота = 0;

  constructor(
    private readonly onChunk: (samples: Float32Array, sampleRate: number) => void,
    private readonly cut: CutOptions = LIVE_CUT,
  ) {}

  push(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return;
    // Частота сменилась (другой микрофон) — старое уходит своим куском.
    if (this.частота && sampleRate !== this.частота) this.flush();
    this.частота = sampleRate;
    this.части.push(samples);
    this.отсчётов += samples.length;
    while (this.отсчётов >= this.cut.maxSec * sampleRate) {
      const всё = this.склеить();
      const срез = cutAtPause(всё, sampleRate, this.cut) ?? всё.length;
      this.onChunk(всё.slice(0, срез), sampleRate);
      const остаток = всё.slice(срез);
      this.части = остаток.length > 0 ? [остаток] : [];
      this.отсчётов = остаток.length;
    }
  }

  /** Всё, что накопилось, — последним куском. */
  flush(): void {
    if (this.отсчётов === 0 || !this.частота) return;
    const всё = this.склеить();
    this.части = [];
    this.отсчётов = 0;
    this.onChunk(всё, this.частота);
  }

  private склеить(): Float32Array {
    if (this.части.length === 1) return this.части[0] as Float32Array;
    const out = new Float32Array(this.отсчётов);
    let at = 0;
    for (const ч of this.части) {
      out.set(ч, at);
      at += ч.length;
    }
    return out;
  }
}
