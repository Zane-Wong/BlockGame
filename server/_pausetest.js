'use strict';
/* 联机暂停功能冒烟测试（含「取消暂停」）：
 *   创建(count=2) → 加入 → 开始 →
 *   ① A 暂停 → 双方收到 paused(by=A)
 *   ② 暂停进行中 B 再暂停 → B 收到「已有玩家暂停中」错误
 *   ③ A（发起者）取消暂停 → 双方提前收到 resume（远早于 PR_MS）
 *   ④ 非发起者 B 尝试取消 A 的暂停 → B 收到「只有发起暂停的玩家可以取消」错误
 *   ⑤ A 已用过暂停，再次暂停 → A 收到「已使用过」错误（每位仅一次）
 *   ⑥ B 暂停（B 未用过）→ 双方收到 paused(by=B) → 倒计时结束收到 resume
 * 用法：node server/_pausetest.js
 */
var assert = require('assert');
var { spawn } = require('child_process');
var http = require('http');
var crypto = require('crypto');

/* ---------- 极简 WebSocket 客户端 ---------- */
function WsClient(port, onMsg, onOpen) {
  this.port = port; this.onMsg = onMsg; this.buf = Buffer.alloc(0);
  var self = this;
  var key = crypto.randomBytes(16).toString('base64');
  var req = http.request({
    port: port, host: '127.0.0.1', path: '/',
    headers: {
      'Connection': 'Upgrade', 'Upgrade': 'websocket',
      'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13'
    }
  });
  req.on('upgrade', function (res, socket) {
    self.socket = socket;
    socket.on('data', function (d) { self._onData(d); });
    if (onOpen) onOpen(self);
  });
  req.end();
}
WsClient.prototype._onData = function (d) {
  this.buf = Buffer.concat([this.buf, d]);
  while (this.buf.length >= 2) {
    var op = this.buf[0] & 0x0f;
    var len = this.buf[1] & 0x7f;
    var offset = 2;
    if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(2) * 0x100000000 + this.buf.readUInt32BE(6); offset = 10; }
    if (this.buf.length < offset + len) return;
    var payload = this.buf.slice(offset, offset + len);
    this.buf = this.buf.slice(offset + len);
    if (op === 0x1) this.onMsg(JSON.parse(payload.toString('utf8')));
    else if (op === 0x8) this.socket.end();
  }
};
WsClient.prototype.send = function (obj) {
  var payload = Buffer.from(JSON.stringify(obj));
  var len = payload.length;
  var mask = crypto.randomBytes(4);
  var header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  var masked = Buffer.from(payload);
  for (var i = 0; i < len; i++) masked[i] ^= mask[i & 3];
  this.socket.write(Buffer.concat([header, mask, masked]));
};

var PORT = 8091;
var PR_MS = 1500;   // 测试用短暂停时长
var server = spawn(process.execPath, ['index.js'], {
  cwd: __dirname,
  env: Object.assign({}, process.env, { PORT: PORT, PR_PAUSE_MS: String(PR_MS) })
});
server.stdout.on('data', function (d) { process.stdout.write('[server] ' + d); });
server.stderr.on('data', function (d) { process.stdout.write('[server-err] ' + d); });

setTimeout(runTest, 600);

var r = {
  aByA: 0, bByA: 0, aByB: 0, bByB: 0,
  resumed: 0, earlyResume: false,
  aDoubleErr: false, bActiveErr: false, bCancelErr: false
};
var aPausedAt = 0;

function runTest() {
  var a = new WsClient(PORT, onA, function (c) { c.send({ t: 'create', count: 2, fp: 'A', name: 'Alice', avatar: '🦊' }); });
  var b, roomCode, started = false;

  function onA(m) {
    if (m.t === 'room' && !b) {
      roomCode = m.state.code;
      b = new WsClient(PORT, onB, function (c) { c.send({ t: 'join', code: roomCode, fp: 'B', name: 'Bob', avatar: '🐼' }); });
    }
    if (m.t === 'paused') {
      if (m.by === 0) { r.aByA++; aPausedAt = Date.now();
        // ④ 非发起者 B 在 250ms 后尝试取消（暂停仍在进行）→ 应被拒
        setTimeout(function () { b.send({ t: 'cancelpause' }); }, 250);
        // ③ 发起者 A 在 500ms 后取消 → 双方提前收到 resume
        setTimeout(function () { a.send({ t: 'cancelpause' }); }, 500);
        // ⑤ A 已用过，800ms 后再暂停（应「已使用过」）；⑥ B 1000ms 后暂停（应成功）
        setTimeout(function () { a.send({ t: 'pause' }); }, 800);
        setTimeout(function () { b.send({ t: 'pause' }); }, 1000);
      } else if (m.by === 1) r.aByB++;
    }
    if (m.t === 'resume') {
      r.resumed++;
      if (aPausedAt && (Date.now() - aPausedAt) < PR_MS) r.earlyResume = true;  // ③ 提前结束
    }
    if (m.t === 'error') {
      if (m.msg.indexOf('已使用') >= 0) r.aDoubleErr = true;
      if (m.msg.indexOf('只有发起暂停') >= 0) r.bCancelErr = true;
    }
  }
  function onB(m) {
    if (m.t === 'room' && !started) { a.send({ t: 'start' }); }
    if (m.t === 'start') {
      if (started) return; started = true;
      setTimeout(function () { a.send({ t: 'pause' }); }, 200);   // ① A 暂停
    }
    if (m.t === 'paused') {
      if (m.by === 0) { r.bByA++; b.send({ t: 'pause' }); }       // ② 暂停中再暂停 → 应「已有玩家暂停中」
      else if (m.by === 1) r.bByB++;
    }
    if (m.t === 'error') {
      if (m.msg.indexOf('已有玩家暂停中') >= 0) r.bActiveErr = true;
      if (m.msg.indexOf('只有发起暂停') >= 0) r.bCancelErr = true;   // 非发起者 B 取消被拒（错误发给 B）
    }
  }

  setTimeout(function () {
    try {
      assert.strictEqual(r.aByA, 1, 'A 收到自己(A)的 paused');
      assert.strictEqual(r.bByA, 1, 'B 收到 A 的 paused');
      assert.strictEqual(r.aByB, 1, 'A 收到 B 的 paused');
      assert.strictEqual(r.bByB, 1, 'B 收到自己(B)的 paused');
      assert.ok(r.earlyResume, 'A 取消后双方提前收到 resume（未等到 PR_MS）');
      assert.ok(r.bCancelErr, '非发起者 B 取消被拒');
      assert.ok(r.aDoubleErr, 'A 重复暂停被拒（每位一次）');
      assert.ok(r.bActiveErr, 'B 暂停中再暂停被拒');
      assert.ok(r.resumed >= 2, '至少两次 resume（取消 + B 自动结束）');
      console.log('\n[pause-result] PASS — 全部断言通过');
      console.log(JSON.stringify(r));
      server.kill(); process.exit(0);
    } catch (e) {
      console.log('\n[pause-result] FAIL —', e.message);
      console.log(JSON.stringify(r, null, 2));
      server.kill(); process.exit(1);
    }
  }, PR_MS + 2500);   // 等 B 的第二次暂停自动结束 + 缓冲
}
