/**
 * Minimal H.264 Annex B stream parser for the screenrecord pipeline.
 *
 * The device sends a raw byte stream: NAL units separated by 00 00 01 or
 * 00 00 00 01 start codes, with SPS/PPS appearing before each IDR frame.
 * WebCodecs wants complete access units per EncodedVideoChunk, so this
 * parser groups SPS + PPS + IDR into one key chunk and passes non-IDR
 * slices through as delta chunks.
 */

export interface VideoChunk {
  data: Buffer;
  key: boolean;
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

/** nal_unit_type lives in the low five bits of the first NAL byte. */
function nalType(nal: Buffer): number {
  return nal[0] & 0x1f;
}

const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

export class AnnexBParser {
  private pending: Buffer = Buffer.alloc(0);
  private sps: Buffer | undefined;
  private pps: Buffer | undefined;

  /** avc1.PPCCLL string derived from the last SPS, e.g. avc1.42c029. */
  codec: string | undefined;

  /** Feeds raw bytes in; returns zero or more decode-ready chunks. */
  push(bytes: Buffer): VideoChunk[] {
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, bytes])
      : bytes;
    const chunks: VideoChunk[] = [];
    for (const nal of this.extractCompleteNals()) {
      const chunk = this.onNal(nal);
      if (chunk) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  /** Drops buffered state, e.g. when the stream restarts. */
  reset(): void {
    this.pending = Buffer.alloc(0);
    // SPS/PPS survive a reset on purpose: a restarted stream resends them,
    // and keeping the old ones lets a keyframe decode even if ordering is odd.
  }

  /**
   * Emits the trailing buffered NAL as if the stream had ended. screenrecord
   * goes silent on a static screen, so the final frame of a burst never gets
   * a next start code to terminate it; the caller flushes after a quiet gap.
   */
  flush(): VideoChunk[] {
    const start = findStartCode(this.pending, 0);
    if (start === -1) {
      return [];
    }
    const nal = this.pending.subarray(start.index + start.length);
    this.pending = Buffer.alloc(0);
    const chunk = this.onNal(nal);
    return chunk ? [chunk] : [];
  }

  private *extractCompleteNals(): Generator<Buffer> {
    let start = findStartCode(this.pending, 0);
    while (start !== -1) {
      const dataStart = start.index + start.length;
      const next = findStartCode(this.pending, dataStart);
      if (next === -1) {
        // The final NAL may still be growing; keep it buffered.
        this.pending = this.pending.subarray(start.index);
        return;
      }
      yield this.pending.subarray(dataStart, next.index);
      start = next;
    }
    // No start code at all yet; keep at most the last three bytes, which is
    // all a split start code can occupy.
    if (this.pending.length > 3) {
      this.pending = this.pending.subarray(this.pending.length - 3);
    }
  }

  private onNal(nal: Buffer): VideoChunk | undefined {
    if (nal.length === 0) {
      return undefined;
    }
    switch (nalType(nal)) {
      case NAL_SPS:
        this.sps = Buffer.from(nal);
        if (nal.length >= 4) {
          this.codec = `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
        }
        return undefined;
      case NAL_PPS:
        this.pps = Buffer.from(nal);
        return undefined;
      case NAL_IDR: {
        if (!this.sps || !this.pps) {
          // Cannot decode an IDR without parameter sets; drop it and wait
          // for the next one, which screenrecord precedes with SPS/PPS.
          return undefined;
        }
        const data = Buffer.concat([
          START_CODE,
          this.sps,
          START_CODE,
          this.pps,
          START_CODE,
          nal,
        ]);
        return { data, key: true };
      }
      case NAL_SLICE:
        return { data: Buffer.concat([START_CODE, nal]), key: false };
      default:
        // SEI, AUD and friends carry nothing the decoder needs here.
        return undefined;
    }
  }
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

function findStartCode(
  buffer: Buffer,
  from: number
): { index: number; length: number } | -1 {
  for (let i = from; i + 2 < buffer.length; i++) {
    if (buffer[i] === 0 && buffer[i + 1] === 0) {
      if (buffer[i + 2] === 1) {
        return { index: i, length: 3 };
      }
      if (buffer[i + 2] === 0 && i + 3 < buffer.length && buffer[i + 3] === 1) {
        return { index: i, length: 4 };
      }
    }
  }
  return -1;
}
