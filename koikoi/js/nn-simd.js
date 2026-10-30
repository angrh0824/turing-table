/* ネットの計算を速くする WebAssembly（SIMD）の小さな部品。バイト列をここで組み立てる（外部のファイル・道具なし）
 *
 *   axpy(x, y, n, a):          y[0..n) += a * x[0..n)            （1層目: 入力が 1 の行を足す）
 *   layer(in, nIn, w, nOut, out): out[j] += Σ_i max(in[i],0) * w[i*nOut + j]（0 以下の入力は飛ばす）
 * ポインタはメモリのバイト位置、n・nOut は 4 の倍数。使えない環境では null を返し、JS の計算を使う
 */
(function (root) {
  'use strict';
  function leb(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
  function sleb(n) { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } }
  const sec = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
  const str = s => [...leb(s.length), ...[...s].map(c => c.charCodeAt(0))];
  const I32 = 0x7f, F32 = 0x7d, V128 = 0x7b;
  const get = i => [0x20, i], set = i => [0x21, i], tee = i => [0x22, i], c32 = n => [0x41, ...sleb(n)];
  const ADD = 0x6a, MUL = 0x6c, SHL = 0x74, LTU = 0x49, FGT = 0x5e;
  const simd = op => [0xfd, ...leb(op)];
  const VLOAD = [...simd(0), 0, 0], VSTORE = [...simd(11), 0, 0], SPLAT = simd(19), FADD4 = simd(228), FMUL4 = simd(230);
  const addr = (base, idx) => [...get(base), ...get(idx), ...c32(2), SHL, ADD];

  function build(pages) {
    // axpy(x0, y1, n2, a3) locals j4 i32, av5 v128
    const axpy = [
      0x02, 0x01, I32, 0x01, V128,
      ...get(3), ...SPLAT, ...set(5),
      ...c32(0), ...set(4),
      0x03, 0x40,
      ...addr(1, 4),
      ...addr(1, 4), ...VLOAD,
      ...addr(0, 4), ...VLOAD, ...get(5), ...FMUL4,
      ...FADD4, ...VSTORE,
      ...get(4), ...c32(4), ADD, ...tee(4), ...get(2), LTU, 0x0d, 0,
      0x0b, 0x0b,
    ];
    // layer(in0, nIn1, w2, nOut3, out4) locals i5 j6 row7 i32, v8 f32, vv9 v128
    const layer = [
      0x03, 0x03, I32, 0x01, F32, 0x01, V128,
      ...c32(0), ...set(5),
      0x03, 0x40,
      ...addr(0, 5), 0x2a, 2, 0, ...tee(8),
      0x43, 0, 0, 0, 0, FGT,
      0x04, 0x40,
      ...get(8), ...SPLAT, ...set(9),
      ...get(2), ...get(5), ...get(3), MUL, ...c32(2), SHL, ADD, ...set(7),
      ...c32(0), ...set(6),
      0x03, 0x40,
      ...addr(4, 6),
      ...addr(4, 6), ...VLOAD,
      ...addr(7, 6), ...VLOAD, ...get(9), ...FMUL4,
      ...FADD4, ...VSTORE,
      ...get(6), ...c32(4), ADD, ...tee(6), ...get(3), LTU, 0x0d, 0,
      0x0b,
      0x0b,
      ...get(5), ...c32(1), ADD, ...tee(5), ...get(1), LTU, 0x0d, 0,
      0x0b, 0x0b,
    ];
    const body = b => [...leb(b.length), ...b];
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...sec(1, [0x02, 0x60, 0x04, I32, I32, I32, F32, 0x00, 0x60, 0x05, I32, I32, I32, I32, I32, 0x00]),
      ...sec(3, [0x02, 0x00, 0x01]),
      ...sec(5, [0x01, 0x00, ...leb(pages)]),
      ...sec(7, [0x03, ...str('mem'), 0x02, 0x00, ...str('axpy'), 0x00, 0x00, ...str('layer'), 0x00, 0x01]),
      ...sec(10, [0x02, ...body(axpy), ...body(layer)]),
    ]);
  }

  // bytes 以上のメモリを持つ部品を作る。{ mem: ArrayBuffer を返す関数, axpy, layer }
  function create(bytes) {
    try {
      if (typeof WebAssembly !== 'object') return null;
      const pages = Math.ceil(bytes / 65536) + 1;
      const mod = new WebAssembly.Module(build(pages));
      const inst = new WebAssembly.Instance(mod, {});
      const e = inst.exports;
      return { memory: e.mem, axpy: e.axpy, layer: e.layer };
    } catch (err) { return null; }
  }

  const api = { create, build };
  root.KoikoiSIMD = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
