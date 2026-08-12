'use strict';
/* 联机对战服务器冒烟测试：
 *   1) 纯逻辑：环形攻击 / 胜负裁决
 *   2) 真实 WebSocket 往返：两客户端 create/join/sit/start/clear→attack/dead→over
 * 用法：node server/_smoketest.js
 */
var assert = require('assert');
var { spawn } = require('child_process');
var http = require('http');
var crypto = require('crypto');
var RoomManager = require('./room.js').RoomManager;

/* ---------- 1) 纯逻辑测试 ---------- */
(function logicTest() {
  var mgr = new RoomManager();
  var room = mgr.create(4);
  for (var i = 0; i < 4; i++) room.addPlayer('p' + i, 'P' + i, '🦊');
  assert.strictEqual(room.nextSeat(0), 1, '0→1');
  assert.strictEqual(room.nextSeat(3), 0, '3→0 回环');
  // 杀掉 2 号，环变成 0→1→3→0
  room.seats[2].alive = false;
  assert.strictEqual(room.nextSeat(1), 3, '1→3 跳过死亡');
  assert.strictEqual(room.nextSeat(3), 0, '3→0 仍回环');
  // applyClear 返回下次攻击目标
  var r = room.applyClear('p0', 2);
  assert.strictEqual(r.from, 0); assert.strictEqual(r.to, 1); assert.strictEqual(r.lines, 2);
  // 胜负：杀到只剩 1 人
  var d1 = room.markDead('p1');
  assert.strictEqual(d1.over, false);
  var d2 = room.markDead('p3');
  assert.strictEqual(d2.over, true);
  assert.strictEqual(d2.winner, 0);
  console.log('[logic] OK 环形攻击 / 胜负裁决');
})();

/* ---------- 极简 WebSocket 客户端（仅测试用） ---------- */
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

/* ---------- 2) 真实 WebSocket 往返（含机器人） ---------- */
var PORT = 8090;
// 测试用服务器注入较快的机器人节奏（生产默认 200ms/步，测试里用 50ms×2 以快速验证对局逻辑），
// 避免 9s 超时；生产环境不传该变量即走默认慢速，人类玩家可跟上。
var server = spawn(process.execPath, ['index.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT: PORT, BOT_TICK_MS: '50', BOT_STEPS_PER_TICK: '2' }) });
server.stdout.on('data', function (d) { process.stdout.write('[server] ' + d); });
server.stderr.on('data', function (d) { process.stdout.write('[server-err] ' + d); });

setTimeout(runFlowTest, 600);

function runFlowTest() {
  var log = [];
  var a = new WsClient(PORT, onA, function (c) { c.send({ t: 'create', count: 2, fp: 'A', name: 'Alice', avatar: '🦊' }); });
  var b, roomCode, started = false;
  function onA(m) {
    log.push('A<' + m.t);
    if (m.t === 'room' && !b) { roomCode = m.state.code; b = new WsClient(PORT, onB, function (c) { c.send({ t: 'join', code: roomCode, fp: 'B', name: 'Bob', avatar: '🐼' }); }); }
    if (m.t === 'attack') { log.push('  A sees attack ' + m.from + '→' + m.to + ' x' + m.lines); }
    if (m.t === 'over') { finishFlow(true, 'over winner=' + m.winner); }
  }
  function onB(m) {
    log.push('B<' + m.t);
    if (m.t === 'room' && !started) { a.send({ t: 'start' }); }     // A 是房主，直接开始（仅一次）
    if (m.t === 'attack') { log.push('  B sees attack ' + m.from + '→' + m.to + ' x' + m.lines); }
    if (m.t === 'start') {
      if (started) return; started = true;
      // 开局后：A 消 2 行攻击 B；随后 B 判负
      a.send({ t: 'clear', lines: 2 });
      setTimeout(function () { b.send({ t: 'dead' }); }, 150);
    }
  }
  var done = false;
  function finishFlow(ok, extra) {
    if (done) return; done = true;
    console.log('\n[flow] ' + log.join('\n       '));
    console.log('[flow-result] ' + (ok ? 'PASS' : 'FAIL') + (extra ? ' — ' + extra : ''));
    if (!ok) { server.kill(); process.exit(1); }
    runBotTest();                                                   // 接着测机器人流程
  }
  setTimeout(function () { finishFlow(false, 'timeout'); }, 4000);
}

function runBotTest() {
  var log = [];
  var c = new WsClient(PORT, onC, function (cl) { cl.send({ t: 'create', count: 4, fp: 'C', name: 'Carol', avatar: '🐯' }); });
  var gotStart = false, gotSnapshot = false, botCount = 0, attackSeen = false, botCuredSeen = false, scheduled = false;
  function onC(m) {
    log.push('C<' + m.t);
    if (m.t === 'room') {
      var bots = m.state.seats.filter(function (s) { return s && s.bot; }).length;
      // 初次 room（bots=0）：手动加 2 个机器人（只调度一次，避免 create 的双 room 消息重复触发）
      if (!gotStart && bots === 0 && !scheduled) {
        scheduled = true;
        c.send({ t: 'addbot' });
        setTimeout(function () { c.send({ t: 'addbot' }); }, 120);
      }
    }
    if (m.t === 'snapshot') {
      gotSnapshot = true;
      var ps = m.state.players;
      botCount = ps.filter(function (p) { return p && p.bot; }).length;
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (p && p.bot && p.board) {
          var rows = p.board.split('/');
          var last = rows[rows.length - 1];
          if (last && last.indexOf('#') >= 0) botCuredSeen = true;   // 机器人收到了固化块
        }
      }
    }
    if (m.t === 'attack') { attackSeen = true; log.push('  C sees attack ' + m.from + '→' + m.to + ' x' + m.lines); }
    if (m.t === 'start' && !gotStart) { gotStart = true; }
  }
  setTimeout(function () { c.send({ t: 'start' }); }, 500);          // 手动加 2 机器人后开始，其余空位自动补
  var done = false;
  function finishBot(ok, extra) {
    if (done) return; done = true;
    console.log('\n[bot] ' + log.join('\n      '));
    console.log('[bot-result] ' + (ok ? 'PASS' : 'FAIL') + (extra ? ' — ' + extra : ''));
    server.kill();
    process.exit(ok ? 0 : 1);
  }
  // 等待机器人 AI 跑出攻击 / 固化（每 1s 推进，初始延迟 3~8s）
  setTimeout(function () {
    var ok = gotStart && gotSnapshot && botCount >= 3 && attackSeen;
    finishBot(ok, 'start=' + gotStart + ' snapshot=' + gotSnapshot + ' bots=' + botCount + ' attack=' + attackSeen + ' botCured=' + botCuredSeen);
  }, 9000);
}
