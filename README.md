# doc-online

多人在线 Markdown 实时协作文档：一整块所见即所得的正文、Confluence 风格的附件与文档内表格，还能导出 `.md` / `.doc`。零框架：Node 原生 `http` + `ws`，浏览器原生 ES Module，冲突解决是自己写的 OT（操作变换）引擎。

## 快速开始

```bash
npm install
npm start          # http://localhost:3000
PORT=4000 npm start
npm test           # node --test，88 个用例
```

打开 <http://localhost:3000> 新建或打开文档，用顶栏的 `share link` / `read-only link` 把地址发给别人即可同时编辑（只读链接带 `?mode=view`，服务端会拒绝它的写请求）。身份（clientId、昵称）存在 `localStorage`，同一浏览器多开标签会顶掉前一个连接（收到 `kicked`，页面给出提示并转为只读）。

## 所见即所得

没有源码栏，也不存在「预览」这个概念：Markdown 是模型，屏幕上的 contenteditable 树是它的视图。

- **双向桥**在 `public/js/serialize.mjs`：`renderMarkdown(text)` 画出 DOM，`serializeDocument(root)` 读回文本和一张「节点 → 字符偏移」表。往返是幂等的：`serialize(render(x))` 一次就到不动点。
- **光标住在 Markdown 偏移里**（`{start,end}`），所以远端 op 能用 `transformPosition` 平移它，重画后再放回对应的 DOM 位置；同伴的选区反过来用偏移表定位到 Range 矩形上画。
- **一次遍历写全局偏移**：块先写自己的前缀（`# `、`> `、`- `、`` ``` ``）再记 `begin`，于是 `marks.get(node).start` 永远是内容起点；表格按单元格逐个写，列宽 padding 与 `serializeTable` 共用同一批 helper，所以网格里敲出来的行和模型生成的行字节一致。
- **块级插入的落点**由 `public/js/blocks.mjs` 纯函数算：光标在句子中间时，新块等这一行走完再落下，前后各补一个空行；光标在代码块或表格里时，插入被推到整块之后（`blockEndForCaret()`），永远不会劈开围栏或某一行。
- **大纲跳转先查偏移表**：栏上一行指的是标题那行的行首（`#` 的位置），而 `marks` 里标题块的 `start` 是正文起点，两者差着一截 `# ` 前缀。所以点一行时先在 `marks` 里找这一行对应的标题，再 `placeCaret` 到它——不会让两套坐标各说各话。
- **中文输入不重画**：`compositionstart` 记下基文本，`compositionend` 把整段结果作为一次 `makeEdit` 提交，远端内容不会在拼音中途替换掉 DOM。
- **撤销是应用级的**（`Cmd/Ctrl` + `Z` / `Shift+Z` / `Y`）：innerHTML 重画会让浏览器原生撤销栈指向已经死掉的节点。
- 标题 / 引用 / 列表这类整块改写命令在代码块或单元格里会拒绝执行并给出提示；行内命令（加粗、斜体、删除线、行内代码、链接）不受限。

## 协作模型

- **文档是一串纯文本**，操作变换也只作用在这串文本上；富结构（表格、图片、代码块）都是文本里的标记。
- **操作（op）** 是组件数组：`{retain:n}` / `{insert:"s"}` / `{delete:n}`，位置由各组件消耗的基础长度隐式推出。
- **全覆盖约定**：每个 op 必须读完整篇基础文档（结尾要显式 retain 到底）。`apply()` 会校验，覆盖不足直接报错，因此落后的客户端会立刻暴露而不是静默错位。客户端的 `makeEdit(before, after)` 自动满足该约定。
- **服务端权威排序**：房间按到达顺序提交，`revision` 单调递增。客户端记录已确认的 `revision` 和一个 FIFO `pending` 队列，发消息时 `baseRevision = revision + pending.length - 1`。
- **收到并发 op** 时，用 `transformPair(pending, remote)` 逐个改写自己未确认的操作，`theirs` 用于喂入远端结果；双方由此收敛到同一文本。
- **服务端收到过期 op** 时，用 `opLog`（保留最近 512 条）把它依次 rebase 到当前状态；同时插入的先后顺序决定谁在前（早提交的在前）。超出 `opLog` 范围则回 `stale`，客户端重新拉快照，并把未确认的本地改动带回去（不丢字）。
- **`ack` 携带文档长度**：本地长度与服务端不一致时自动 `resync`，避免累积漂移。
- **表格与附件都留在这条链路里**：表格就是 GFM 文本，工具栏每次点击都是把整块重写后作为一条普通 edit 发出去；附件的字节从不进入文档，进文档的只有 `/files/<docId>/<fileId>` 这个引用。

## 通信协议

WebSocket：`/ws?doc=<id>&client=<1..32 位 [A-Za-z0-9_-]>&name=<显示名>[&mode=view]`，JSON 信封，一条消息一个意图。

| 方向 | 消息 |
| --- | --- |
| 客户端 → 服务端 | `edit {seq, baseRevision, op}`、`presence {selection:{start,end}, typing}`、`title {title}`、`resync`、`ping {at}` |
| 服务端 → 客户端 | `doc {id,title,text,revision,files,updatedAt,users}`、`ack {seq,revision,length}`、`op {from,revision,op}`、`users {users}`、`title {title}`、`files {files}`、`stale {…doc,reason}`、`kicked`、`error {message,code?}`、`pong {at}` |

HTTP：`GET /api/health`、`GET|POST /api/docs`、`GET|PATCH|DELETE /api/docs/:id`（`GET` 优先返回内存中的实时文本）、`GET /api/docs/:id/export?format=md|doc` 导出、`GET|PUT /api/docs/:id/files` 与 `DELETE /api/docs/:id/files/:fileId` 管附件、`GET /files/:docId/:fileId[/<name>]` 下载附件。

上传是裸字节 `PUT`，文件名/类型/上传者放在查询串里（`?name=&type=&who=`），因此浏览器不需要任何上传库。之后只有元数据经 `files` 消息广播给所有同伴（包括上传者自己），二进制不过 WebSocket。

## 数据与持久化

JSON 文件落盘，无数据库：

```
data/index.json               # 文档目录（id/title/revision/fileCount/时间）
data/docs/<id>.json           # 单篇全文 + 附件元数据
data/attachments/<docId>/<fileId>   # 附件字节，不带扩展名
```

写入走「临时文件 + rename」，每篇文档的写操作用 Promise 链串行化，进程退出（SIGINT/SIGTERM）时先关闭连接、`flush()` 落盘再退出。`data/` 已在 `.gitignore` 中。删除文档会连带清空它的附件目录。

## 界面

- 单栏正文（760px 居中），全部工具都在工具栏：加粗 / 斜体 / 删除线 / 行内代码 / 链接 / H1 / H2 / 引用 / 无序表 / 有序表 / 正文 / 分割线 / 代码块 / 表格 / 附件。空文档只有一行引导语，第一次输入即取代它。
- **大纲栏**是正文左边的一条轨道：`public/js/outline.mjs` 直接从模型文本里读标题（围栏里的 `#` 不算），所以每一行都和页面上某个 `<hN>` 对得上，缩进按嵌套深度而不是标题级别。行名左侧的箭头只收起自己那一棵子树，同级标题不受影响；折叠了哪些标题按文档记在 `localStorage`，属于你的视图，从不上线。点行名把光标放进那条标题并把它滚进视野，光标移动时所在小节同步高亮；只读页同样可以折叠和跳转。栏头右上角的 `«` 将整条栏收成 34px 细条，细条上的 `»` 再展开，这个开关记在 `localStorage`。窗口窄于 860px 时大纲栏整条隐藏。
- 快捷键：`Cmd/Ctrl` + `B` `I` `E` `K`，`Cmd/Ctrl` + `Z` / `Shift+Z` / `Y` 撤销重做，`Tab` / `Shift+Tab` 在表格里跳格（不在表格里插入两个空格），`Enter` 在表格内等于 `Tab`，其余块结构交给浏览器的 contenteditable 行为、由序列化器归一化回文本。粘贴一律按纯文本处理。
- **表格**：点 `table` 弹出 6×5 网格选择器，插入对齐好的 GFM 表格，第一个单元格随即选中默认表头——直接打字就替换掉它。光标进入单元格后出现第二条工具栏：上下插行、左右插列、删行删列、左/中/右对齐、`copy`（制表符分隔，可直接粘进电子表格）。走到最后一格自动补一行。新插入的列是空格子，不会造出重名表头；只移动光标永远不会改写一张参差表格的格式。
- **附件**：点 `attach`、把文件拖进正文、或直接粘贴（截图就靠粘贴）。第三栏面板展示缩略图、大小、时间和上传者，提供 `link`（复制可分享地址）和 `remove`（二次确认）。每次上传会在光标处独占一块插入引用：图片是 `![name](/files/…)`，其余是 `[📎 name](/files/…)`。
- **导出**：页脚 `export .md` 给模型原文，`export .doc` 给 Word 能直接打开的 HTML（内联样式覆盖标题、引用、代码、表格边框；Word 没有页面地址可解析相对路径，所以 `src`/`href` 会按请求来源补成绝对地址）。
- 远端光标与选区浮在正文之上（用 `Range.getClientRects()` 定位，一帧内多次变更只画一次），带昵称标签；顶栏显示在线成员与「N editing」。
- 断线重连或服务端 `stale` 重同步时，横幅会保留那份没发出去的本地改动，点 `restore` 才重新提交，不会覆盖别人的内容。

## 安全约束

- Markdown 渲染先转义再拼标签，链接只放行 `http/https/mailto/ftp`、`#锚点` 和相对路径，拦截 `javascript:`、`data:`。
- 同伴颜色在进入 `style` 前必须匹配 `/^#[0-9a-f]{3,8}$/i`。
- 文档 id 与附件 id 都限定 `/^[A-Za-z0-9_-]{1,40}$/`，静态文件服务校验解析后的路径仍在根目录内。附件路径只由这两个 id 拼出：上传的文件名只是元数据，永远不参与寻址。
- 上传的文件只有在白名单内（图片、PDF、`text/plain`）才允许内联渲染，其余一律 `application/octet-stream` + `Content-Disposition: attachment` + `x-content-type-options: nosniff`。也就是说，别人传上来的 `.html`、`.svg` 无法在本源上执行脚本。
- 导出的响应同样带 `nosniff`，文件名由标题经 `cleanName` 过滤得到；`.doc` 里的 `<style>` 是常量，用户内容一律走渲染器转义。
- 上限：单文档 500 000 字符、HTTP 请求体 1 MB、WS 帧 256 KB、单次编辑 ≤512 个组件且插入 ≤100 000 字符、`opLog` 512 条、单个附件 10 MB、单文档 50 个附件。

## 已知限制

- 没有账号体系：任何拿到链接的人都能编辑，只读链接靠 `mode=view` 约定，服务端仅拒绝该连接的写请求。上传走 REST、不属于任何连接，因此只读页只是不显示按钮，服务端还没有可以据此鉴权的身份。
- 位置按 UTF-16 码元计算，emoji 等代理对可能被切开。
- 自研 OT 只处理纯文本插入/删除，不含富文本区间属性和离线多端合并。所见即所得能表达的也只有渲染器支持的那套 Markdown 标记——颜色、字号、单元格合并都不在文档模型里。
- 视图依赖浏览器自己的 contenteditable 行为，各家在回车、删除、粘贴上的差异由序列化器兜住（读回来仍是同一份文本）。唯一的归一化代价：文末多余换行会被吃掉，所以每篇文档第一次落地时多一次广播。
- 两人同时操作同一张表格时，块级重写按文本合并，可能交错出行列——表格块没有加锁。
- 大纲只认行首的 ATX 标题：setext 式（`===` / `---` 下划线）标题和引用块里的 `> # 标题`不会出现在栏上；同一级的同名标题算作同一节，折叠时一起折叠。折叠掉光标正好所在的那一节时，高亮会落到它可见的祖先上。
- `.doc` 是 Word-HTML 而不是 OOXML（无依赖的服务器不该自带 zip 写库），其中的图片与附件链接要服务器仍可访问才显示得出来。
- 单进程内存房间；水平扩展需要额外的广播层。

## 目录

```
server.js              HTTP + WS 入口
server/hub.mjs         连接管理、协议、广播
server/room.mjs        房间：提交、rebase、在线状态
server/store.mjs       JSON 文件存储
server/files.mjs       附件字节、内联/下载策略
server/export.mjs      .md / .doc 导出
shared/ot.mjs          OT 引擎（apply/makeEdit/compose/transformPair）
public/                大厅、编辑页、样式
public/js/editor.js    编辑页装配：输入、工具栏、表格操作、快捷键
public/js/serialize.mjs DOM <-> Markdown 双向桥 + 偏移映射
public/js/blocks.mjs   块级插入的落点算术（纯函数）
public/js/outline.mjs  从模型文本读标题树（纯函数）
public/js/outline.js   大纲栏：折叠、跳转、当前小节高亮
public/js/markdown.mjs 渲染器（纯字符串，服务端导出复用）
public/js/table.mjs    GFM 表格模型（纯文本进、纯文本出）
public/js/presence.js  同伴光标层
public/js/attachments.js  上传、附件面板、Markdown 引用
test/ · shared/*.test  存储/附件/房间/导出/端到端/OT/序列化/块级插入/表格/大纲/光标层测试
```

依赖仅 `ws`。Node ≥ 22.13。MIT。
