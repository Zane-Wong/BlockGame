# 魔方坠落 · 联机对战模式 — 实施指南

> 本文档随开发进度持续更新，记录**已落地的实现步骤、架构、协议与后续计划**。
> 对应项目：`diamonds-game`（手势俄罗斯方块 H5 Canvas 游戏）。
> 设计语言与单人对战（`index.html`）保持一致：深色底 + 紫/青径向渐变、玻璃拟态面板、紫→青渐变主按钮、金色点缀。

---

## 一、总体方案（已确定）

| 项 | 决策 |
|---|---|
| 对战形态 | 独自为战 FFA（Free-For-All） |
| 胜负 | 最后存活者胜（淘汰制） |
| 攻击方式 | 按座位号成环攻击下一号（末位攻击首位；2 人互攻） |
| 攻击效果 | 消行时向目标底部**压入固化块**（从下往上累计，目标无法普通消除） |
| 自愈 | 自己每消一行，挖掉自己一层固化块（下挖一层） |
| 账号 | 浏览器指纹（`localStorage` 模拟）唯一标识；新玩家初始化昵称/头像 |
| 房间 | 房主选人数(2–9) → 生成房间码 → 座位网格落座 → 满座房主开始 |
| 服务器 | **Node.js + 原生 WebSocket（零外部依赖，仅用内置模块）**，客户端权威模拟 + 服务器权威裁决存活/胜负/环形攻击 |
| 客户端 | 复用现有引擎（`core.js`/`render.js`/`fx.js`/`gesture.js`）+ 新增 `net.js`/`battle.js` |

---

## 二、已完成的实现步骤

1. **核心引擎扩展（`src/core.js`）**
   - `Board.cured` 计数；`addCured(n)` 底部插入 n 行固化块（整盘上移，溢出返回 `true`）；`digCured()` 挖掉最底一层固化块。
   - `fullRows()` 跳过底部固化带（固化行不可被普通消行清除）。
   - `TZ.packBoard(board)` / `TZ.unpackRow(str)`：棋盘序列化（每行 10 字符：`空格=空`、`#=固化`、`1..7=方块`），用于网络同步缩略图。
2. **固化块渲染（`src/render.js`）**
   - `curedBlock()`：斜纹底 + 金色描边，明显区别于可消除方块。
   - `thumbStack(rows)`：直接用序列化行渲染缩略图，复用主渲染风格。
   - `curedLine(curedRows)`：固化带顶部金线，标注"被压到的高度"。
3. **引擎事件钩子（`src/game.js`）**
   - `stepClearing` 消行后触发 `onBattleClear(n)`（自愈 + 广播攻击）。
   - `gameOver` 触发 `onGameOver(s,l,b)`（由 battle 接管结局，替代单人结算遮罩）。
4. **零依赖 WebSocket 服务器（`server/`）**
   - `ws.js`：RFC6455 握手 + 帧编解码（含 TCP 分片处理），仅用 `crypto`/`http`。
   - `room.js`：`RoomManager` / `Room` — 房间生命周期、环形攻击结算 `nextSeat`、存活/胜负裁决、棋盘中转。
   - `index.js`：HTTP 静态托管（含目录穿越防护）+ WS 升级 + 消息路由 + 120ms 快照节流。
5. **客户端网络层（`src/net.js`）**
   - `TZ.Net`：连接、JSON 收发、按消息类型分发、断线回调；默认连同源 8080，可用 `?ws=` 覆盖。
6. **对战控制器与页面（`src/battle.js` + `battle.html`）**
   - 账号初始化（指纹/昵称/头像）→ 首页 → 选人数 → 房间（码+分享链接+座位网格）→ 对战。
   - 本地 `Game` 引擎驱动主棋盘（手势/渲染/特效完全一致）；对手以缩略图（同源 Renderer）实时显示。
   - `onAttack`：被攻击时在本地棋盘插入固化块；`onLocalClear`：自愈 + 发送攻击；`onGameOver`：发送 dead。
   - HUD（存活/排名/我的固化/攻击目标）、结算遮罩、退出。
7. **房间机器人补位（`server/botengine.js` + `server/room.js` + `server/index.js` + 客户端）**
   - 需求：人数不齐也能开局。两种触发：① 房主点「添加机器人」手动补（`addbot` 消息，仅房主、未开局）；② 点「开始」时若未满座，服务器自动用机器人填满剩余空位（`Room.fillBots()`）。
   - 机器人**从空盘真实对局**，不是装饰：服务端运行 `server/botengine.js`（复刻 `src/core.js` 的纯力学——7-bag、SRS 旋转、重力、碰撞、锁定、消行、固化上升 `addCured` / 自愈 `digCured`），用 El-Tetris 特征集（列变换权重最高）挑选落点，真正地往下掉、堆叠、消行。
   - 每个机器人座位带一个 `BotEngine` 实例（`room.js` 的 `addBot`/`fillBots` 创建）；`snapshot` 直接从引擎读取 `board`/`piece`/`score`/`lines`，与客户端 `TZ.packBoard` 格式完全一致，缩略图直接可用。
   - 服务器真实驱动（每 100ms 推进 2 帧）：机器人消行即触发环形攻击下一个存活座位（真实攻击环）；被攻击时 `engine.addCured()` 让固化块**真实从底部上升**，填满 20 行即判负；消行后镜像人类"自愈"挖掉一层固化块。
   - 真实玩家全部离开后房间自动解散，避免机器人空转。
8. **验证**
   - `server/_smoketest.js`：纯逻辑 + 双客户端真实 WS 往返（create→join→start→clear→dead→over）**+ 机器人流程**（手动加 2 机器人 → 开始自动补第 3 个 → 机器人 AI 发出 attack、棋盘固化带增长）全部通过。
   - `server/_enginetest.js`：固化块插入/自愈/满行跳过/序列化往返全部通过。
   - 全部 JS `node --check` 通过；服务器静态托管 `battle.html` 与 `src/*` 返回 200。

---

## 三、文件地图

| 文件 | 职责 |
|---|---|
| `src/core.js` | 纯逻辑：棋盘/方块/SRS/寻路 + **固化块 + 序列化（新增）** |
| `src/render.js` | Canvas 渲染：棋盘/方块/导航/蓄力 + **固化块/缩略图/金线（新增）** |
| `src/game.js` | 主循环/状态机/手势接线 + **对战事件钩子（新增）** |
| `src/gesture.js` `src/fx.js` `src/tutorial.js` | 手势 / 粒子音效 / 新手引导（原样复用） |
| `src/net.js` | **新增** 浏览器 WebSocket 客户端 |
| `src/battle.js` | **新增** 账号/房间流程/对手缩略图/网络事件接线 |
| `battle.html` | **新增** 对战页面（沿用单人设计语言） |
| `server/ws.js` | **新增** 零依赖 WebSocket 服务核心 |
| `server/room.js` | **新增** 房间与对战逻辑（服务器权威） |
| `server/index.js` | **新增** HTTP 静态 + WS 路由入口 |
| `server/package.json` | **新增** `npm start` → `node index.js` |
| `BATTLE_IMPLEMENTATION.md` | 本指南 |

---

## 四、网络协议

客户端 ↔ 服务器均为 JSON，字段 `t` 为消息类型。

**客户端 → 服务器**
| t | 字段 | 说明 |
|---|---|---|
| `hello` | `fp,name,avatar` | 身份声明 |
| `create` | `count,fp,name,avatar` | 建房（自动落座 0 号、成为房主） |
| `join` | `code,fp,name,avatar` | 凭房间码加入（落座首个空位） |
| `sit` | `seat` | 切换到空座位（服务器自动处理换座并广播） |
| `start` | — | 房主开始；**人数不足时机器人自动补满剩余空位**（广播 `room`→`start`→`snapshot`） |
| `addbot` | — | 房主在未开局时手动添加一个机器人到首个空座位（仅房主） |
| `clear` | `lines` | 本地消了 `lines` 行 → 服务器解析环形攻击目标并广播 `attack`（机器人受害者由服务器记账固化块） |
| `dead` | — | 本地顶出/判负 |
| `sync` | `board,score,lines` | 节流上报本地棋盘（用于对手缩略图），~160ms |
| `leave` | — | 离开房间 |
| `ping` | — | 心跳 |

**服务器 → 客户端**
| t | 字段 | 说明 |
|---|---|---|
| `welcome` | `id` | 连接确认 |
| `room` | `state{code,count,seats[],you,host,started}` | 房间状态变化；`seats[].bot=true` 标记为机器人 |
| `start` | `order,you` | 对战开始（座位序即攻击环，已含机器人） |
| `snapshot` | `state{players[]}` | 棋盘中转（含 board 包），120ms 节流；`players[].bot=true` 表示机器人 |
| `attack` | `from,to,lines` | 环形攻击：目标 `to` 在本地插入 `lines` 行固化块（受害者为机器人时由服务器记账） |
| `dead` | `seat` | 某人出局（含机器人填满 20 行判负） |
| `over` | `winner` | 胜负裁决（`winner=-1` 表示无人生还） |
| `error` | `msg` | 业务错误（房间不存在/已满/非房主开始/非房主加机器人等） |

环形攻击：`nextSeat(from)` = 在**存活**座位中 `from` 的下一个；存活 ≤1 时返回 `-1`。胜负：存活 ≤1 即结束。

---

## 五、运行方式

```bash
# 1) 启动服务器（零依赖，Node ≥ 14）
node server/index.js
#   默认端口 8080，可用 PORT 环境变量覆盖

# 2) 浏览器打开对战页
#   单人对战： http://localhost:8080/
#   联机对战： http://localhost:8080/battle
#   局域网其他设备：把 localhost 换成服务器 IP；多开标签页/设备即可同房对战
```

- 两标签页开 `http://<ip>:8080/battle`：一个"创建房间"（记下房间码），另一个"加入房间"输码，双方落座后房主点"开始对战"。
- 分享链接：`battle.html?room=XZ-XXXX` 一点即加入对应房间（新玩家先初始化账号）。

---

## 六、与现有设计语言的一致性

- 背景、配色、面板、按钮、金线全部沿用 `index.html` 的令牌（`#05060d`、紫→青渐变 `#7c5cf5→#4ac2d8`、玻璃面板 `rgba(255,255,255,0.045)`、金色 `#ffd84d`）。
- 主棋盘**直接复用 `Game` + `Renderer`**，手势操作、消行粒子、蓄力弹弓、旋转动效与单人完全一致。
- 对手缩略图用**同一个 `Renderer`** 绘制，固化块样式与主棋盘统一。

---

## 七、规划 / 待办（按实际落地情况更新）

> 状态图例：✅ 已落地 ｜ ⬜ 仍规划中

- [x] **真实对手棋盘同步**：已落地。服务器除 120ms 棋盘快照（落定块 + 固化带）外，还端到端同步活动方块 `piece:{t,r,x,y}`（人类经 `sync` 上报、机器人经 `BotEngine.pieceNet()` 读取）。对手缩略图同时显示**真实堆叠 + 下落中的方块**。差分同步属可选增强，休闲场景下暂不需要。
- [x] **房间机器人补位**：已落地（手动 `addbot` + 开局自动补满；服务器 AI 引擎驱动真实消行/攻击/自愈/判负）。可作为断线重连"临时托管"的基础。
- [x] **旁观 / 观战模式**：已落地。被淘汰且整局未结束时，右侧缩略图浮于淘汰蒙层之上，点击**任意**存活对手即可切换观战视角；当前观战对象以青色脉冲边框高亮；被观战者出局自动跳下一存活对手。观战采用持续渲染循环（`spectateLoop`），切换即时生效。
- [x] **结算排名明细**：已落地。服务器记录淘汰顺序 `deathOrder`，`over` 时 `buildRanking(winner)` 生成排行（胜者第一、越晚出局名次越高，含座位/昵称/头像/是否 AI/分数/行数），客户端渲染 🥇🥈🥉 排行榜。
- [ ] **服务器权威防作弊**（竞技向）：仍规划中。当前为休闲向"客户端权威 + 服务器裁决固化/胜负"。竞技化需将方块下落/消行计算上移服务器，客户端仅上报操作。
- [ ] **断线重连**：仍规划中。当前断线即判负；可复用机器人托管机制，使掉线者由机器人代打直至重连。
- [ ] **历史战绩**：仍规划中（结算排名明细已做，但跨局历史记录/个人战绩库未做）。
- [ ] **小程序适配**：仍规划中。需将 `Gesture` 事件层与 `Net` 的 WebSocket 替换为小程序 API（逻辑层 `core.js` 已与平台解耦，可直接复用）。
- [ ] **音效/震动**对战攻击反馈强化：仍规划中。现有引擎已具备 `shake`/`particles`/`audio`，但联机攻击/被攻击的专属音效与震动反馈尚未接线。

---

## 八、开发自测命令

```bash
node server/_smoketest.js   # 逻辑 + 真实 WS 往返
node server/_enginetest.js # 固化块引擎单测
node --check src/battle.js # 语法校验
```
