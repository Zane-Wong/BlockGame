'use strict';
/* 联机暂停功能冒烟测试：
 *   创建(count=2) → 加入 → 开始 →
 *   A 暂停 → 双方收到 paused(by=A) →
 *   A 重复暂停 → A 收到「已用过」错误 →
 *   B 在暂停中再暂停 → B 收到「已有玩家暂停中」错误 →
 *   倒计时结束 → 双方收到 resume →
 *   B 暂停（B 未用过）→ 双方收到 paused(by=B) → 验证「每位一次」
 * 用法：node server/_pausetest.js
 */
var assert = require('assert');
var { spawn } = require('child_process');
var http = require('http');
var crypto = require('crypto');

/* ---------- 极简 WebSocket 客户端（与 _smoketest 同款） ---------- */
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

var results = { aByA: 0, aByB: 0, bByA: 0, bByB: 0, aResume: 0, bResume: 0, aDoubleErr: false, bActiveErr: false };

function runTest() {
  var a = new WsClient(PORT, onA, function (c) { c.send({ t: 'create', count: 2, fp: 'A', name: 'Alice', avatar: '🦊' }); });
  var b, roomCode, started = false;

  function onA(m) {
    if (m.t === 'room' && !b) {
      roomCode = m.state.code;
      b = new WsClient(PORT, onB, function (c) { c.send({ t: 'join', code: roomCode, fp: 'B', name: 'Bob', avatar: '🐼' }); });
    }
    if (m.t === 'paused') { if (m.by === 0) results.aByA++; else if (m.by === 1) results.aByB++; }
    if (m.t === 'resume') results.aResume++;
    if (m.t === 'error' && m.msg.indexOf('已使用') >= 0) results.aDoubleErr = true;
  }
  function onB(m) {
    if (m.t === 'room' && !started) { a.send({ t: 'start' }); }
    if (m.t === 'start') {
      if (started) return; started = true;
      // 开局后 A 发起暂停
      setTimeout(function () { a.send({ t: 'pause' }); }, 200);
    }
    if (m.t === 'paused') {
      if (m.by === 0) results.bByA++; else if (m.by === 1) results.bByB++;
      // B 在暂停进行中再请求暂停 → 应收到「已有玩家暂停中」
      b.send({ t: 'pause' });
      // A 重复暂停（已用过）→ 应收到「已使用过」
      a.send({ t: 'pause' });
    }
    if (m.t === 'resume') results.bResume++;
    if (m.t === 'resume') {
      // 倒计时结束后：B 发起自己的暂停（B 尚未用过）→ 应再次成功
      setTimeout(function () { b.send({ t: 'pause' }); }, 200);
    }
    if (m.t === 'error') {
      if (m.msg.indexOf('已有玩家暂停中') >= 0) results.bActiveErr = true;
    }
  }

  setTimeout(function () {
    try {
      assert.strictEqual(results.aByA, 1, 'A 收到自己(A)的 paused');
      assert.strictEqual(results.bByA, 1, 'B 收到 A 的 paused');
      assert.strictEqual(results.aByB, 1, 'A 收到 B 的 paused');
      assert.strictEqual(results.bByB, 1, 'B 收到自己(B)的 paused');
      assert.ok(results.aDoubleErr, 'A 重复暂停被拒');
      assert.ok(results.bActiveErr, 'B 暂停中再暂停被拒');
      assert.strictEqual(results.aResume, 1, 'A 收到 resume');
      assert.strictEqual(results.bResume, 1, 'B 收到 resume');
      console.log('\n[pause-result] PASS — 全部断言通过');
      console.log(JSON.stringify(results));
      server.kill(); process.exit(0);
    } catch (e) {
      console.log('\n[pause-result] FAIL —', e.message);
      console.log(JSON.stringify(results, null, 2));
      server.kill(); process.exit(1);
    }
  }, PR_MS + 1500);   // 等第一次暂停结束 + B 的第二次暂停广播
}
