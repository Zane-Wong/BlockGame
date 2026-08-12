/*!
 * ============================================================================
 *  魔方坠落 · 联机对战 — 零依赖 WebSocket 服务核心
 * ----------------------------------------------------------------------------
 *  @file         server/ws.js
 *  @description  RFC6455 握手 + 帧编解码（仅用 Node 内置模块，无需 npm 安装）
 *  @author       wangzhuo <mail_zhuo@163.com>
 * ============================================================================
 *
 *  createWebSocketServer(httpServer, { onConnect }) 会在 httpServer 的
 *  'upgrade' 事件上完成握手，并为每个连接返回一个 WsConn 对象：
 *    conn.send(obj)        —— 发送 JSON
 *    conn.onMessage(fn)    —— 收到 JSON 消息时回调
 *    conn.onClose(fn)      —— 连接断开时回调
 *    conn.close()          —— 主动关闭
 */
'use strict';
var crypto = require('crypto');

var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------- 单个连接 ---------- */
function WsConn(socket) {
  this.socket = socket;
  this.buf = Buffer.alloc(0);
  this.onMessage = null;
  this.onClose = null;
  this.closed = false;
  this._fragOp = null;
  this._fragChunks = [];
  var self = this;

  socket.on('data', function (d) {
    self.buf = Buffer.concat([self.buf, d]);
    self._parse();
  });
  socket.on('close', function () { self._die(); });
  socket.on('error', function () { self._die(); });
}

WsConn.prototype._die = function () {
  if (this.closed) return;
  this.closed = true;
  if (this.onClose) try { this.onClose(); } catch (e) { /* ignore */ }
};

WsConn.prototype._parse = function () {
  while (true) {
    var buf = this.buf;
    if (buf.length < 2) return;
    var b0 = buf[0], b1 = buf[1];
    var fin = (b0 & 0x80) !== 0;
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var offset = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      // 64 位长度：取高 32 位（几乎用不到，但避免越界）
      len = buf.readUInt32BE(6) * 0x100000000 + buf.readUInt32BE(2);
      offset = 10;
    }
    var maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return;
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return;
    var payload = Buffer.from(buf.slice(offset, offset + len));
    if (masked) {
      for (var i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.buf = buf.slice(offset + len);

    if (opcode === 0x8) { this.close(); return; }          // close
    if (opcode === 0x9) { this._sendRaw(0xA, payload); continue; } // ping→pong
    if (opcode === 0xA) continue;                          // pong, ignore

    // 文本 / 二进制 / 续帧
    if (opcode === 0x0) {
      this._fragChunks.push(payload);
      if (fin) {
        var full = Buffer.concat(this._fragChunks);
        this._fragChunks = []; this._fragOp = null;
        this._emit(0x1, full);
      }
      continue;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) { this._fragOp = opcode; this._fragChunks = [payload]; continue; }
      this._emit(opcode, payload);
    }
  }
};

WsConn.prototype._emit = function (opcode, payload) {
  if (opcode !== 0x1) return;            // 我们仅用文本(JSON)
  var text = payload.toString('utf8');
  var msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (this.onMessage) try { this.onMessage(msg); } catch (e) { /* ignore */ }
};

WsConn.prototype._sendRaw = function (opcode, payload) {
  if (this.closed || !this.socket.writable) return;
  var len = payload.length;
  var header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { /* ignore */ }
};

WsConn.prototype.send = function (obj) {
  this._sendRaw(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
};

WsConn.prototype.close = function () {
  if (this.closed) return;
  try { this._sendRaw(0x8, Buffer.alloc(0)); } catch (e) { /* ignore */ }
  try { this.socket.end(); } catch (e) { /* ignore */ }
  this._die();
};

/* ---------- 握手入口 ---------- */
function createWebSocketServer(httpServer, opts) {
  opts = opts || {};
  var onConnect = opts.onConnect || function () {};

  httpServer.on('upgrade', function (req, socket) {
    var key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    var accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    var headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '\r\n'
    ].join('\r\n');
    socket.write(headers);
    socket.setNoDelay(true);

    var conn = new WsConn(socket);
    onConnect(conn, req);
  });
}

module.exports = { createWebSocketServer: createWebSocketServer, WsConn: WsConn };
