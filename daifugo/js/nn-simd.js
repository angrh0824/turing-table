/* ネットの計算を速くする WebAssembly（SIMD）の小さな部品。バイト列をここで組み立てる（外部のファイル・道具なし）
 *
 *   addrows(w, idx, n, len, out): out[0..len) += Σ_k w[idx[k]*len .. +len)   （0/1 の入力: 立っている特徴の行を足す）
 *   layer(in, nIn, w, nOut, out):  out[j] += Σ_i max(in[i], 0) * w[i*nOut + j] （0 以下の入力は飛ばす）
 * 学習の後ろ向き:
 *   rowsaxpy(x, nx, y, ny, G):     G[i*ny + j] += max(x[i], 0) * y[j]          （外積を足す。0 以下の x は飛ばす）
 *   scatter(G, idx, n, len, v):    G[idx[k]*len .. +len) += v                  （立っている特徴の行に足す）
 *   matvec(W, nIn, nOut, y, out):  out[i] = Σ_j W[i*nOut + j] * y[j]
 * ポインタはメモリのバイト位置、len・nOut は 4 の倍数。使えない環境では null を返し、JS の計算を使う
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DFSimd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function leb(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
  function sleb(n) { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } }
  const sec = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
  const str = s => [...leb(s.length), ...[...s].map(c => c.charCodeAt(0))];
  const I32 = 0x7f, F32 = 0x7d, V128 = 0x7b;
  const get = i => [0x20, i], set = i => [0x21, i], tee = i => [0x22, i], c32 = n => [0x41, ...sleb(n)];
  const ADD = 0x6a, MUL = 0x6c, SHL = 0x74, LTU = 0x49, GEU = 0x4f, FGT = 0x5e;
  const simd = op => [0xfd, ...leb(op)];
  const VLOAD = [...simd(0), 0, 0], VSTORE = [...simd(11), 0, 0], SPLAT = simd(19), FADD4 = simd(228), FMUL4 = simd(230);
  const ILOAD = [0x28, 2, 0], FLOAD = [0x2a, 2, 0], FSTORE = [0x38, 2, 0], FADD = 0x92, LANE = l => [...simd(31), l];
  const addr = (base, idx) => [...get(base), ...get(idx), ...c32(2), SHL, ADD];

  function build(pages) {
    // addrows(w0, idx1, n2, len3, out4) locals k5 j6 row7
    const addrows = [
      0x01, 0x03, I32,
      ...c32(0), ...set(5),
      0x02, 0x40,
      0x03, 0x40,
      ...get(5), ...get(2), GEU, 0x0d, 1,
      ...get(0), ...addr(1, 5), ...ILOAD, ...get(3), MUL, ...c32(2), SHL, ADD, ...set(7),
      ...c32(0), ...set(6),
      0x03, 0x40,
      ...addr(4, 6),
      ...addr(4, 6), ...VLOAD,
      ...addr(7, 6), ...VLOAD,
      ...FADD4, ...VSTORE,
      ...get(6), ...c32(4), ADD, ...tee(6), ...get(3), LTU, 0x0d, 0,
      0x0b,
      ...get(5), ...c32(1), ADD, ...set(5),
      0x0c, 0,
      0x0b,
      0x0b,
      0x0b,
    ];
    // layer(in0, nIn1, w2, nOut3, out4) locals i5 j6 row7 i32, v8 f32, vv9 v128
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
    // rowsaxpy(x0, nx1, y2, ny3, G4) locals i5 j6 row7 i32, v8 f32, vv9 v128
    const rowsaxpy = [
      0x03, 0x03, I32, 0x01, F32, 0x01, V128,
      ...c32(0), ...set(5),
      0x03, 0x40,
      ...addr(0, 5), ...FLOAD, ...tee(8),
      0x43, 0, 0, 0, 0, FGT,
      0x04, 0x40,
      ...get(8), ...SPLAT, ...set(9),
      ...get(4), ...get(5), ...get(3), MUL, ...c32(2), SHL, ADD, ...set(7),
      ...c32(0), ...set(6),
      0x03, 0x40,
      ...addr(7, 6),
      ...addr(7, 6), ...VLOAD,
      ...addr(2, 6), ...VLOAD, ...get(9), ...FMUL4,
      ...FADD4, ...VSTORE,
      ...get(6), ...c32(4), ADD, ...tee(6), ...get(3), LTU, 0x0d, 0,
      0x0b,
      0x0b,
      ...get(5), ...c32(1), ADD, ...tee(5), ...get(1), LTU, 0x0d, 0,
      0x0b, 0x0b,
    ];
    // scatter(G0, idx1, n2, len3, v4) locals k5 j6 row7
    const scatter = [
      0x01, 0x03, I32,
      ...c32(0), ...set(5),
      0x02, 0x40,
      0x03, 0x40,
      ...get(5), ...get(2), GEU, 0x0d, 1,
      ...get(0), ...addr(1, 5), ...ILOAD, ...get(3), MUL, ...c32(2), SHL, ADD, ...set(7),
      ...c32(0), ...set(6),
      0x03, 0x40,
      ...addr(7, 6),
      ...addr(7, 6), ...VLOAD,
      ...addr(4, 6), ...VLOAD,
      ...FADD4, ...VSTORE,
      ...get(6), ...c32(4), ADD, ...tee(6), ...get(3), LTU, 0x0d, 0,
      0x0b,
      ...get(5), ...c32(1), ADD, ...set(5),
      0x0c, 0,
      0x0b,
      0x0b,
      0x0b,
    ];
    // matvec(W0, nIn1, nOut2, y3, out4) locals i5 j6 row7 i32, acc8 v128
    const matvec = [
      0x02, 0x03, I32, 0x01, V128,
      ...c32(0), ...set(5),
      0x03, 0x40,
      0x43, 0, 0, 0, 0, ...SPLAT, ...set(8),
      ...get(0), ...get(5), ...get(2), MUL, ...c32(2), SHL, ADD, ...set(7),
      ...c32(0), ...set(6),
      0x03, 0x40,
      ...get(8),
      ...addr(7, 6), ...VLOAD, ...addr(3, 6), ...VLOAD, ...FMUL4,
      ...FADD4, ...set(8),
      ...get(6), ...c32(4), ADD, ...tee(6), ...get(2), LTU, 0x0d, 0,
      0x0b,
      ...addr(4, 5),
      ...get(8), ...LANE(0), ...get(8), ...LANE(1), FADD, ...get(8), ...LANE(2), FADD, ...get(8), ...LANE(3), FADD,
      ...FSTORE,
      ...get(5), ...c32(1), ADD, ...tee(5), ...get(1), LTU, 0x0d, 0,
      0x0b, 0x0b,
    ];
    const body = b => [...leb(b.length), ...b];
    return new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ...sec(1, [0x01, 0x60, 0x05, I32, I32, I32, I32, I32, 0x00]),
      ...sec(3, [0x05, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ...sec(5, [0x01, 0x00, ...leb(pages)]),
      ...sec(7, [0x06, ...str('mem'), 0x02, 0x00, ...str('addrows'), 0x00, 0x00, ...str('layer'), 0x00, 0x01, ...str('rowsaxpy'), 0x00, 0x02, ...str('scatter'), 0x00, 0x03, ...str('matvec'), 0x00, 0x04]),
      ...sec(10, [0x05, ...body(addrows), ...body(layer), ...body(rowsaxpy), ...body(scatter), ...body(matvec)]),
    ]);
  }

  // bytes 以上のメモリを持つ部品を作る: { memory, addrows, layer }。使えなければ null
  function create(bytes) {
    try {
      if (typeof WebAssembly !== 'object') return null;
      const pages = Math.ceil(bytes / 65536) + 1;
      const inst = new WebAssembly.Instance(new WebAssembly.Module(build(pages)), {});
      const e = inst.exports;
      return { memory: e.mem, addrows: e.addrows, layer: e.layer, rowsaxpy: e.rowsaxpy, scatter: e.scatter, matvec: e.matvec };
    } catch (err) { return null; }
  }
  return { create, build };
});
