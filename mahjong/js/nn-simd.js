/* ネットの計算を速くする WebAssembly（SIMD）の小さな部品。バイト列をここで組み立てる（外部のファイル・道具なし）
 *
 *   rows(idx, nIdx, w, stride, out): out[0..stride) += Σ_k w[idx[k]*stride + 0..stride)   （1層目: 立っている特徴の行を足す）
 *   layer(in, nIn, w, nOut, out):    out[j] += Σ_i in[i] * w[i*nOut + j]（in[i] が 0 以下の行は飛ばす）
 *   axpy(x, y, n, a):                 y[0..n) += a * x[0..n)
 *   dot(x, y, n) → Σ x[i]*y[i]
 *   scat(idx, nIdx, gw, stride, v):  gw の行 idx[k] に v[0..stride) を足す（1層目の勾配）
 *   back(in, nIn, w, gw, dout, nOut, din): in[i] > 0 の行だけ gw[i,:] += in[i]*dout、din[i] = w[i,:]·dout（ほかは 0）
 * ポインタはメモリのバイト位置。stride・nOut・n は 4 の倍数。使えない環境では null を返し、JS の計算を使う
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MJSIMD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function leb(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
  function sleb(n) { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } }
  const sec = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
  const str = s => [...leb(s.length), ...[...s].map(c => c.charCodeAt(0))];
  const I32 = 0x7f, F32 = 0x7d, V128 = 0x7b;
  const get = i => [0x20, i], set = i => [0x21, i], tee = i => [0x22, i], c32 = n => [0x41, ...sleb(n)];
  const ADD = 0x6a, MUL = 0x6c, SHL = 0x74, LTU = 0x49, FGT = 0x5e, FADD = 0x92;
  const simd = op => [0xfd, ...leb(op)];
  const VLOAD = [...simd(0), 0, 0], VSTORE = [...simd(11), 0, 0], SPLAT = simd(19), FADD4 = simd(228), FMUL4 = simd(230);
  const LANE = l => [...simd(31), l];
  const ILOAD = [0x28, 2, 0], FLOAD = [0x2a, 2, 0], FSTORE = [0x38, 2, 0], FZERO = [0x43, 0, 0, 0, 0];
  const addr = (base, idx) => [...get(base), ...get(idx), ...c32(2), SHL, ADD];

  function build(pages) {
    // rows(idx0, nIdx1, w2, stride3, out4) 局所 k5 j6 row7
    const rows = [
      0x01, 0x03, I32,
      ...get(1), 0x04, 0x40,
      ...c32(0), ...set(5),
      0x03, 0x40,
      ...get(2), ...get(0), ...get(5), ...c32(2), SHL, ADD, ...ILOAD, ...get(3), MUL, ...c32(2), SHL, ADD, ...set(7),
      ...c32(0), ...set(6),
      0x03, 0x40,
      ...addr(4, 6),
      ...addr(4, 6), ...VLOAD,
      ...addr(7, 6), ...VLOAD,
      ...FADD4, ...VSTORE,
      ...get(6), ...c32(4), ADD, ...tee(6), ...get(3), LTU, 0x0d, 0,
      0x0b,
      ...get(5), ...c32(1), ADD, ...tee(5), ...get(1), LTU, 0x0d, 0,
      0x0b,
      0x0b,
      0x0b,
    ];
    // layer(in0, nIn1, w2, nOut3, out4) 局所 i5 j6 row7 (i32)、v8 (f32)、vv9 (v128)
    const layer = [
      0x03, 0x03, I32, 0x01, F32, 0x01, V128,
      ...c32(0), ...set(5),
      0x03, 0x40,
      ...addr(0, 5), ...FLOAD, ...tee(8),
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
    // axpy(x0, y1, n2, a3) 局所 j4 (i32)、av5 (v128)
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
    // dot(x0, y1, n2) → f32 局所 j3 (i32)、acc4 (v128)
    const dot = [
      0x02, 0x01, I32, 0x01, V128,
      0x43, 0, 0, 0, 0, ...SPLAT, ...set(4),
      ...c32(0), ...set(3),
      0x03, 0x40,
      ...get(4),
      ...addr(0, 3), ...VLOAD, ...addr(1, 3), ...VLOAD, ...FMUL4,
      ...FADD4, ...set(4),
      ...get(3), ...c32(4), ADD, ...tee(3), ...get(2), LTU, 0x0d, 0,
      0x0b,
      ...get(4), ...LANE(0), ...get(4), ...LANE(1), FADD, ...get(4), ...LANE(2), FADD, ...get(4), ...LANE(3), FADD,
      0x0b,
    ];
    // scat(idx0, nIdx1, gw2, stride3, v4): gw の各行 idx[k] に v を足す（1層目の勾配） 局所 k5 j6 row7
    const scat = [
      0x01, 0x03, I32,
      ...get(1), 0x04, 0x40,
      ...c32(0), ...set(5),
      0x03, 0x40,
      ...get(2), ...get(0), ...get(5), ...c32(2), SHL, ADD, ...ILOAD, ...get(3), MUL, ...c32(2), SHL, ADD, ...set(7),
      ...c32(0), ...set(6),
      0x03, 0x40,
      ...addr(7, 6),
      ...addr(7, 6), ...VLOAD,
      ...addr(4, 6), ...VLOAD,
      ...FADD4, ...VSTORE,
      ...get(6), ...c32(4), ADD, ...tee(6), ...get(3), LTU, 0x0d, 0,
      0x0b,
      ...get(5), ...c32(1), ADD, ...tee(5), ...get(1), LTU, 0x0d, 0,
      0x0b,
      0x0b,
      0x0b,
    ];
    // back(in0, nIn1, w2, gw3, dout4, nOut5, din6): in[i] > 0 の行だけ gw[i,:] += in[i]*dout、din[i] = w[i,:]·dout（ほかは din[i] = 0）
    //   局所 i7 j8 row9 (i32)、v10 (f32)、vv11 acc12 (v128)
    const rowAddr = (base, j) => [...get(base), ...get(9), ADD, ...get(j), ...c32(2), SHL, ADD];
    const back = [
      0x03, 0x03, I32, 0x01, F32, 0x02, V128,
      ...c32(0), ...set(7),
      0x03, 0x40,
      ...addr(0, 7), ...FLOAD, ...tee(10), ...FZERO, FGT,
      0x04, 0x40,
      ...get(10), ...SPLAT, ...set(11),
      ...get(7), ...get(5), MUL, ...c32(2), SHL, ...set(9),
      ...FZERO, ...SPLAT, ...set(12),
      ...c32(0), ...set(8),
      0x03, 0x40,
      ...rowAddr(3, 8),
      ...rowAddr(3, 8), ...VLOAD,
      ...addr(4, 8), ...VLOAD, ...get(11), ...FMUL4,
      ...FADD4, ...VSTORE,
      ...get(12),
      ...rowAddr(2, 8), ...VLOAD,
      ...addr(4, 8), ...VLOAD, ...FMUL4,
      ...FADD4, ...set(12),
      ...get(8), ...c32(4), ADD, ...tee(8), ...get(5), LTU, 0x0d, 0,
      0x0b,
      ...addr(6, 7),
      ...get(12), ...LANE(0), ...get(12), ...LANE(1), FADD, ...get(12), ...LANE(2), FADD, ...get(12), ...LANE(3), FADD,
      ...FSTORE,
      0x05,
      ...addr(6, 7), ...FZERO, ...FSTORE,
      0x0b,
      ...get(7), ...c32(1), ADD, ...tee(7), ...get(1), LTU, 0x0d, 0,
      0x0b,
      0x0b,
    ];
    const body = b => [...leb(b.length), ...b];
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // 型: 0 (i32×5)→()、1 (i32,i32,i32,f32)→()、2 (i32,i32,i32)→f32、3 (i32×7)→()
      ...sec(1, [0x04, 0x60, 0x05, I32, I32, I32, I32, I32, 0x00, 0x60, 0x04, I32, I32, I32, F32, 0x00, 0x60, 0x03, I32, I32, I32, 0x01, F32, 0x60, 0x07, I32, I32, I32, I32, I32, I32, I32, 0x00]),
      ...sec(3, [0x06, 0x00, 0x00, 0x01, 0x02, 0x00, 0x03]),
      ...sec(5, [0x01, 0x00, ...leb(pages)]),
      ...sec(7, [0x07, ...str('mem'), 0x02, 0x00, ...str('rows'), 0x00, 0x00, ...str('layer'), 0x00, 0x01, ...str('axpy'), 0x00, 0x02, ...str('dot'), 0x00, 0x03, ...str('scat'), 0x00, 0x04, ...str('back'), 0x00, 0x05]),
      ...sec(10, [0x06, ...body(rows), ...body(layer), ...body(axpy), ...body(dot), ...body(scat), ...body(back)]),
    ]);
  }
  // bytes 以上のメモリを持つ部品を作る。{ memory, rows, layer, axpy, dot } か null
  function create(bytes) {
    try {
      if (typeof WebAssembly !== 'object') return null;
      const pages = Math.ceil(bytes / 65536) + 1;
      const inst = new WebAssembly.Instance(new WebAssembly.Module(build(pages)), {});
      const e = inst.exports;
      return { memory: e.mem, rows: e.rows, layer: e.layer, axpy: e.axpy, dot: e.dot, scat: e.scat, back: e.back };
    } catch (err) { return null; }
  }
  return { create, build };
});
