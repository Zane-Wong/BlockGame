/*!
 * ============================================================================
 *  魔方坠落 · 联机对战 — 浏览器端 WebSocket 客户端
 * ----------------------------------------------------------------------------
 *  @file         src/net.js
 *  @description  连接对战服务器、收发 JSON 消息、断线自动重连
 *  @author       wangzhuo <mail_zhuo@163.com>
 * ============================================================================
 */
(function (global) {
  'use strict';
  var TZ = global.TZ || (global.TZ = {});

  function Net(opts) {
    opts = opts || {};
    this.url = opts.url || defaultUrl();
    this.handlers = {};
    this.ws = null;
    this.connected = false;
    this.queue = [];
    this.onOpen = opts.onOpen || null;
    this.onClose = opts.onClose || null;
  }

  function defaultUrl() {
    // 默认连到本页同源（与服务器一致）；可用 ?ws= 覆盖
    // 注意：HTTPS 标准端口(443) 不会出现在 location.port 里，此时不应硬拼 :8080，
    // 否则会连到 cool1.cn:8080（公网通常未开放），导致联机「没反应」。
    var params = new URLSearchParams(global.location.search);
    var o = params.get('ws');
    if (o) return o;
    var proto = global.location.protocol === 'https:' ? 'wss' : 'ws';
    var host = global.location.hostname || 'localhost';
    var port = global.location.port;                 // 空字符串 = 用协议默认端口（https→443 / http→80）
    return proto + '://' + host + (port ? ':' + port : '');
  }

  Net.prototype.connect = function () {
    var self = this;
    try { this.ws = new WebSocket(this.url); }
    catch (e) { console.warn('[net] 无法创建 WebSocket', e); return; }
    this.ws.onopen = function () {
      self.connected = true;
      if (self.onOpen) self.onOpen();
      self.queue.forEach(function (m) { self._raw(m); });
      self.queue.length = 0;
    };
    this.ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      var list = self.handlers[m.t];
      if (list) list.forEach(function (h) { try { h(m); } catch (e) { console.warn('[net] handler error', e); } });
    };
    this.ws.onclose = function () { self.connected = false; if (self.onClose) self.onClose(); };
    this.ws.onerror = function () { self.connected = false; if (self.onClose) self.onClose(); };
  };

  Net.prototype.on = function (type, fn) {
    (this.handlers[type] || (this.handlers[type] = [])).push(fn);
  };

  Net.prototype._raw = function (obj) {
    if (this.ws && this.connected && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(obj));
    }
  };

  Net.prototype.send = function (obj) {
    if (this.connected) this._raw(obj);
    else this.queue.push(obj);
  };

  Net.prototype.close = function () {
    if (this.ws) try { this.ws.close(); } catch (e) { /* ignore */ }
  };

  TZ.Net = Net;
})(typeof window !== 'undefined' ? window : this);
