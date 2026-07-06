import * as assert from "assert";
import { AnnexBParser } from "../video/h264";

const SC3 = [0, 0, 1];
const SC4 = [0, 0, 0, 1];

// Realistic-looking NAL payloads. First byte: forbidden_zero_bit 0,
// nal_ref_idc, nal_unit_type in the low five bits.
const SPS = [0x67, 0x42, 0xc0, 0x29, 0xaa, 0xbb];
const PPS = [0x68, 0xce, 0x3c, 0x80];
const IDR = [0x65, 0x11, 0x22, 0x33];
const SLICE = [0x41, 0x9a, 0x44, 0x55];
const SEI = [0x06, 0x05, 0xff];

function buf(...parts: number[][]): Buffer {
  return Buffer.from(parts.flat());
}

suite("AnnexBParser", () => {
  test("groups SPS, PPS and IDR into one key chunk", () => {
    const parser = new AnnexBParser();
    const chunks = parser.push(
      buf(SC4, SPS, SC4, PPS, SC4, IDR, SC4, SLICE, SC4, SLICE)
    );
    // The trailing slice is buffered until the next start code arrives.
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].key, true);
    assert.deepStrictEqual(
      [...chunks[0].data],
      [...buf(SC4, SPS, SC4, PPS, SC4, IDR)]
    );
    assert.strictEqual(chunks[1].key, false);
    assert.deepStrictEqual([...chunks[1].data], [...buf(SC4, SLICE)]);
  });

  test("derives the codec string from the SPS", () => {
    const parser = new AnnexBParser();
    parser.push(buf(SC4, SPS, SC4, PPS, SC4, IDR, SC4));
    assert.strictEqual(parser.codec, "avc1.42c029");
  });

  test("handles NALs split across arbitrary chunk boundaries", () => {
    const stream = buf(SC4, SPS, SC4, PPS, SC4, IDR, SC3, SLICE, SC4, SLICE, SC4);
    for (let cut = 1; cut < stream.length - 1; cut++) {
      const parser = new AnnexBParser();
      const chunks = [
        ...parser.push(stream.subarray(0, cut)),
        ...parser.push(stream.subarray(cut)),
      ];
      assert.strictEqual(chunks.length, 3, `split at ${cut}`);
      assert.deepStrictEqual(
        chunks.map((c) => c.key),
        [true, false, false],
        `split at ${cut}`
      );
    }
  });

  test("accepts three-byte start codes", () => {
    const parser = new AnnexBParser();
    const chunks = parser.push(buf(SC3, SPS, SC3, PPS, SC3, IDR, SC3));
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].key, true);
  });

  test("drops an IDR that arrives before parameter sets", () => {
    const parser = new AnnexBParser();
    const chunks = parser.push(buf(SC4, IDR, SC4, SPS, SC4, PPS, SC4, IDR, SC4));
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].key, true);
  });

  test("ignores SEI and other non-essential NALs", () => {
    const parser = new AnnexBParser();
    const chunks = parser.push(
      buf(SC4, SEI, SC4, SPS, SC4, PPS, SC4, IDR, SC4, SEI, SC4, SLICE, SC4)
    );
    assert.deepStrictEqual(
      chunks.map((c) => c.key),
      [true, false]
    );
  });

  test("keeps parameter sets across a reset so restarts resume fast", () => {
    const parser = new AnnexBParser();
    parser.push(buf(SC4, SPS, SC4, PPS, SC4));
    parser.reset();
    const chunks = parser.push(buf(SC4, IDR, SC4));
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].key, true);
  });

  test("flush emits the trailing NAL after a quiet stream", () => {
    const parser = new AnnexBParser();
    // Static screen: SPS, PPS and a single IDR arrive, then silence.
    const chunks = parser.push(buf(SC4, SPS, SC4, PPS, SC4, IDR));
    assert.strictEqual(chunks.length, 0);
    const flushed = parser.flush();
    assert.strictEqual(flushed.length, 1);
    assert.strictEqual(flushed[0].key, true);
    // A second flush has nothing left to emit.
    assert.deepStrictEqual(parser.flush(), []);
  });

  test("garbage before the first start code is discarded", () => {
    const parser = new AnnexBParser();
    const noise = [0x12, 0x34, 0x56, 0x78, 0x9a];
    const chunks = parser.push(
      buf(noise, SC4, SPS, SC4, PPS, SC4, IDR, SC4)
    );
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].key, true);
  });
});
