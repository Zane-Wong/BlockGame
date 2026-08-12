'use strict';
/* 验证对战核心引擎：固化块插入/自愈、满行跳过固化带、棋盘序列化。
 * 用法：node server/_enginetest.js
 */
global.window = global;            // 让 core.js 把 TZ 挂到 global
require('../src/core.js');
var TZ = global.TZ;
var assert = require('assert');

var b = new TZ.Board();
// 在可见区底部放一个满行（非固化），应可被正常消除
for (var x = 0; x < b.cols; x++) b.grid[b.total - 1][x] = { type: 'I', color: '#fff' };
var full = b.fullRows();
assert.ok(full.indexOf(b.total - 1) >= 0, '普通满行应被检测');

// 插入 3 行固化块
var of = b.addCured(3);
assert.strictEqual(b.cured, 3, 'cured=3');
assert.strictEqual(of, false, '未溢出');
// 固化带内的行不应出现在 fullRows（被跳过的判定）
var fr = b.fullRows();
var inCured = fr.some(function (y) { return y >= b.total - b.cured; });
assert.strictEqual(inCured, false, '固化带不参与满行');
assert.ok(fr.indexOf(b.total - 1) < 0, '末行(固化)不应被消除');
// 底部三行应为固化
for (var y = b.total - 3; y < b.total; y++)
  for (var x2 = 0; x2 < b.cols; x2++) assert.ok(b.grid[y][x2] && b.grid[y][x2].cured, '底行应为固化');

// 自愈挖一层
b.digCured();
assert.strictEqual(b.cured, 2, 'dig 后 cured=2');
assert.strictEqual(b.grid[b.total - 1][0].cured, true, '仍有固化行');

// 溢出检测：填满顶部再插入
var b2 = new TZ.Board();
for (var y2 = 0; y2 < b2.total; y2++) for (var x3 = 0; x3 < b2.cols; x3++) b2.grid[y2][x3] = { type: 'T', color: '#fff' };
var of2 = b2.addCured(1);
assert.strictEqual(of2, true, '顶部有内容时应溢出');

// 序列化往返
var b3 = new TZ.Board();
b3.grid[b.total - 1][0] = { type: 'L', color: TZ.COLORS.L };
b3.addCured(2);
var packed = TZ.packBoard(b3);
assert.strictEqual(typeof packed, 'string');
var rows = packed.split('/');
assert.strictEqual(rows.length, b3.rows, '行数匹配');
// 末两行应为固化
var lastRow = TZ.unpackRow(rows[rows.length - 1]);
var last2 = TZ.unpackRow(rows[rows.length - 2]);
assert.ok(lastRow[0].cured && last2[0].cured, '末两行应为固化');
// L 方块应在某处（被上移，但不丢）
var foundL = false;
for (var ri = 0; ri < rows.length; ri++) {
  var rr = TZ.unpackRow(rows[ri]);
  for (var ci = 0; ci < rr.length; ci++) if (rr[ci] && rr[ci].type === 'L') foundL = true;
}
assert.ok(foundL, 'L 方块应保留在棋盘某处');

console.log('[engine] OK 固化块 / 满行跳过 / 序列化 全部通过');
