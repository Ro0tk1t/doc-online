# doc-online

多人在线 Markdown 实时协作文档：一整块所见即所得的正文、Confluence 风格的附件与文档内表格、账号与每篇文档的权限，还能导出 `.md` / `.doc`。零框架：Node 原生 `http` + `ws`，浏览器原生 ES Module，冲突解决是自己写的 OT（操作变换）引擎，密码与会话令牌来自 `node:crypto`。

## 快速开始

```bash
npm install
npm start          # http://localhost:3000
PORT=4000 npm start
npm test           # node --test，146 个用例
```

打开 <http://localhost:3000> 先注册。**空服务器上第一个注册的账号就是 admin**，此后注册仍然敞开，所以它适合放在一个你邀请进来的团队里，而不是公开对外服务。建档需要账号，读 `public` 文档不需要。

身份就是服务端下发的 `doc_auth` cookie，`localStorage` 和查询串里都不再参与「我是谁」。`?mode=view` 依旧把一条链接限成只读，但它现在只能收紧服务端的判定，永远不能放宽。顶栏的 `sharing` 按钮（只有 owner 看得见）决定可见性与共享名单。

## 账号与权限

每篇文档四个角色，判定全在一个纯函数里（`server/access.mjs`），外加一个账号级角色：

| 角色 | 怎么得到 | 能做什么 |
| --- | --- | --- |
| `owner` | 文档是自己建的，或者你是 admin | 读、写、改名、删除、改共享 |
| `editor` | owner 把你加进共享名单 | 读、写、增删附件 |
| `viewer` | owner 把你加进共享名单 | 读、导出、复制链接——不能写 |
| `reader` | 匿名访问一篇 `public` 文档 | 读、导出——不能写，也看不到共享名单 |
| — | 以上都不满足，而文档是 `private` | 什么都做不了，连接直接被拒 |

- **`visibility`** 只有 `private`（默认）和 `public`。public 意味着全世界都能读这一篇，它不会把任何人变成 editor。
- **`admin`** 是账号角色而不是文档角色：admin 在任何文档上都解析成 `owner`，这正是为了把卡死或失去主人的文档捞回来。admin 在大厅里多看一个 `Accounts` 面板，可以升降角色、停用与启用账号。最后一个 admin 既不能降级也不能停用，否则就没人能撤销这件事了。
- **socket 每次下发快照都带着这个连接自己的 `access`**，页面不用自己推断权限：同一个房间里两个人可以拿到不同答案；共享名单中途变了，被降级的那位会收到新快照，被移除的那位连接会以 `4003` 关闭。
- **同一套规则在三处同时生效**：REST 路由（`requireRole`）、WebSocket 握手（进房之前先 `roleFor`）、以及房间内每一次写入。藏起一个按钮从来不算检查。
- **密码**用 scrypt（`N=16384, r=8, p=1`）加每人 16 字节随机盐，比对走 `timingSafeEqual`。名字不存在时同样跑一次完整 scrypt，所以「没这个账号」和「密码错了」花的时间一样。
- **会话**是 `data/sessions.json` 里 24 字节随机不透明令牌，绝对过期 30 天，不做滑动续期，所以吊销就是删一行。停用账号会立刻清掉它的全部会话。
- **登录限速**在内存里按账号名计：15 分钟内失败 5 次起等 30 秒，再失败每次多等 30 秒。它是减速带而不是锁死台账，重启即清零。
- **CSRF**：cookie 是 `HttpOnly; SameSite=Lax`，并且所有改写类请求还要比对请求自身的 `Origin`/`Referer`，因为 Lax 管不到顶层 POST。连接是 TLS（或反代带上 `x-forwarded-proto: https`）时再加 `Secure`。


## 所见即所得

没有源码栏，也不存在「预览」这个概念：Markdown 是模型，屏幕上的 contenteditable 树是它的视图。

- **双向桥**在 `public/js/serialize.mjs`：`renderMarkdown(text)` 画出 DOM，`serializeDocument(root)` 读回文本和一张「节点 → 字符偏移」表。往返是幂等的：`serialize(render(x))` 一次就到不动点。
- **光标住在 Markdown 偏移里**（`{start,end}`），所以远端 op 能用 `transformPosition` 平移它，重画后再放回对应的 DOM 位置；同伴的选区反过来用偏移表定位到 Range 矩形上画。
- **一次遍历写全局偏移**：块先写自己的前缀（`# `、`> `、`- `、`` ``` ``）再记 `begin`，于是 `marks.get(node).start` 永远是内容起点；表格按单元格逐个写，列宽 padding 与 `serializeTable` 共用同一批 helper，所以网格里敲出来的行和模型生成的行字节一致。
- **块级插入的落点**由 `public/js/blocks.mjs` 纯函数算：光标在句子中间时，新块等这一行走完再落下，前后各补一个空行；光标在代码块或表格里时，插入被推到整块之后（`blockEndForCaret()`），永远不会劈开围栏或某一行。走出围栏的那一步也在这一层（`planFenceExit()`）：它只看光标那一行是不是空的、下面还有没有代码。
- **围栏里的一次换行是一个位置**：浏览器把敲进代码块的回车做成 `<br>`，而 `<br>` 不是文字节点，于是光标偏移只能退回到上一行末尾——比屏幕上的位置早一行。序列化器给围栏内真正写下的每个换行记一个 mark（`Writer.nl(breaks, node)`），光标停在哪个空行就读回哪个空行。段落里的换行不受影响：那边被吸收掉的 `<br>` 不产出文本，也就没有位置可记。
- **块命令吃下整行**：选中一片文字点 `block` / 行内 `code`（跨行那种），`linesSpan()` 把选区扩成它碰到的整行，`planReplace()` 用新块替换这几行，前后照样补空行。光标只是停在一行上（没有选区）时仍然是「在这行下面加一个空块」，不会把句子吞进代码里。
- **高亮只是渲染器的事**：`public/js/highlight.mjs` 把围栏正文切成「注释 / 字符串 / 数字 / 关键字 / 字面量」五类片段，`renderMarkdown` 给每类套一个带颜色的 `<span>`。文本一个字符都不改，所以 `serialize` 读回来还是同一段 Markdown——高亮从不进入文档模型，也不占 OT 的位置。
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

WebSocket：`/ws?doc=<id>&client=<1..32 位 [A-Za-z0-9_-]>[&mode=view]`，JSON 信封，一条消息一个意图。会话 cookie 随握手带上，原来那个 `name=` 参数已经去掉：登录者的名字由账号给出，匿名的则叫 `Guest <clientId 前缀>`。同一个 `client` id 再开一个标签仍会顶掉前一个（`kicked`）。

| 方向 | 消息 |
| --- | --- |
| 客户端 → 服务端 | `edit {seq, baseRevision, op}`、`presence {selection:{start,end}, typing}`、`title {title}`、`resync`、`ping {at}` |
| 服务端 → 客户端 | `doc {id,title,text,revision,files,updatedAt,users,owner,visibility,access}`、`ack {seq,revision,length}`、`op {from,revision,op}`、`users {users}`、`title {title}`、`files {files}`、`stale {…doc,reason}`、`kicked`、`error {message,code?}`、`pong {at}` |

`access` 是 `{role, canEdit, canManage, intent}`，只描述这一个连接，不是整个房间。权限不够的握手会以关闭码 `4003` 拒绝，并先发一条 `error`，其 `code` 是 `need_login`（匿名）或 `forbidden`（已登录但不在名单上）；客户端遇到这个码就不再重连。

HTTP：`POST /api/signup`、`POST /api/login`、`POST /api/logout`、`GET /api/me`（我是谁，以及这台服务器还没有账号）、`GET /api/users?q=`（共享面板按名字找人，仅登录可用）、`GET|POST /api/admin/users[/:id]`（admin：列账号、升降角色、停用启用）、`GET /api/health`、`GET|POST /api/docs`、`GET|PATCH|DELETE /api/docs/:id`、`GET|PUT /api/docs/:id/access`、`GET /api/docs/:id/export?format=md|doc`、`GET|PUT /api/docs/:id/files` 与 `DELETE /api/docs/:id/files/:fileId` 管附件、`GET /files/:docId/:fileId[/<name>]` 下载附件。

`POST /api/docs` 和提交共享名单都要有账号（`401 need_login`）并对该文档有相应权限（`403`，带 `forbidden` / `read_only` / `not_owner` 之一）。能不能读一篇文档在取正文之前判定，所以越权的 `GET`、导出、附件请求得到的是 `403`/`401`，一个字节也不会漏。共享名单本身不算文档可读内容：`grants` 只对 owner 返回，`GET /api/docs/:id/access` 即使文档是 public 也要先登录。

上传是裸字节 `PUT`，文件名与类型放在查询串里（`?name=&type=`），因此浏览器不需要任何上传库；记录在文件上的上传者是谁由 cookie 决定，而不是请求自己声称的。之后只有元数据经 `files` 消息广播给所有同伴（包括上传者自己），二进制不过 WebSocket。

## 数据与持久化

JSON 文件落盘，无数据库：

```
data/index.json               # 文档目录（id/title/revision/fileCount/时间）
data/docs/<id>.json           # 单篇全文 + 附件元数据 + owner/visibility/grants
data/attachments/<docId>/<fileId>   # 附件字节，不带扩展名
data/users.json               # 账号：id、name、scrypt 盐与哈希、role、disabled、createdAt
data/sessions.json            # token -> {user, at}，绝对过期
```

写入走「临时文件 + rename」，每篇文档的写操作用 Promise 链串行化，进程退出（SIGINT/SIGTERM）时先关闭连接、`flush()` 落盘再退出。`data/` 已在 `.gitignore` 中。删除文档会连带清空它的附件目录。密码哈希从不出 `server/users.mjs`：它之上的一切只看到公开投影（`id`、`name`、`role`、`disabled`、`createdAt`）。

文档记录与正文并排多了 `owner`、`visibility`、`grants` 三个字段，整个存储仍然只是一个 JSON 目录。旧数据里没有主人的文档不做迁移：把它挪进 `data/legacy/`，从空服务器开始——一篇没有 owner 的文档回答不了「谁有权共享它」。


## 界面

- **顶栏写清楚你是谁**：顶栏用一枚徽章显示这次访问者的角色（`owner` / `editor` / `viewer`，匿名的显示 `read-only`），匿名读者还会看到一个 `sign in to edit` 链接，回到大厅时这篇文档已经填在「按链接打开」里。自己在成员条上的标签用的是服务端答回来的账号名，谁都没法把自己说成别人。
- **共享面板**（只有 owner 能打开）挂在顶栏的 `sharing` 按钮下：private/public 开关、owner 一行、每个被授权账号一行（各自带 `can edit` / `can read` 下拉和 `remove`），再加一个按精确名字（不区分大小写）找人的输入框。每次改动都是整张名单一次 `PUT`，已经在房间里的同伴下一条消息就会重算自己的权限。
- 单栏正文（760px 居中），全部工具都在工具栏：加粗 / 斜体 / 删除线 / 行内代码 / 链接 / H1 / H2 / H3 / H4 / H5 / 引用 / 无序表 / 有序表 / 正文 / 分割线 / 代码块 / 表格 / 附件。空文档只有一行引导语，第一次输入即取代它。大厅会把「新建文档」和只读链接的生成按钮对没有写权限的访客禁掉。
- **大纲栏**是正文左边的一条轨道：`public/js/outline.mjs` 直接从模型文本里读标题（围栏里的 `#` 不算），所以每一行都和页面上某个 `<hN>` 对得上，缩进按嵌套深度而不是标题级别。行名左侧的箭头只收起自己那一棵子树，同级标题不受影响；折叠了哪些标题按文档记在 `localStorage`，属于你的视图，从不上线。点行名把光标放进那条标题并把它滚进视野，光标移动时所在小节同步高亮；只读页同样可以折叠和跳转。栏头右上角的 `«` 将整条栏收成 34px 细条，细条上的 `»` 再展开，这个开关记在 `localStorage`。窗口窄于 860px 时大纲栏整条隐藏。
- 快捷键：`Cmd/Ctrl` + `B` `I` `E` `K`，`Cmd/Ctrl` + `Z` / `Shift+Z` / `Y` 撤销重做，`Tab` / `Shift+Tab` 在表格里跳格（不在表格里插入两个空格），`Enter` 在表格内等于 `Tab`，其余块结构交给浏览器的 contenteditable 行为、由序列化器归一化回文本。粘贴一律按纯文本处理。
- **代码块**：`block` 把选中的那几行整个搬进围栏（没有选区时仍然只是在这行下面加一个空块），光标随之落进块里，回车就是新的一行代码。**空行上的第二个回车走出代码块**：块内的回车永远属于代码，只有光标所在行是空的、它下面不再有任何代码、且这块至少有两行时才算「出块」——新建块后第一次回车是「开始写代码」，第二次才离开；多行代码中间的空行照旧是代码。从没写过内容的块在出块时一并删掉，不留空壳；落点如果是全文最后一个块，Markdown 表达不了它后面的空段落，于是视图临时放一个 `<p><br></p>` 接住光标，一旦打字它就序列化成正经段落（`planFenceExit`）。行内 `code`（`Cmd/Ctrl` + `E`）写的是模型里的反引号，同一段文字再按一次就取消；选中的文字跨行时它自动升级成代码块——Markdown 的行内 code 放不下换行，以前那样写会同时丢掉换行和这层标记；而行内 code 中间按回车会先把这个 `<code>` 关掉（浏览器默认把元素整个拖到下一行，下一行的正文就成了代码，空 span 被拆开还留下永不闭合的反引号）。围栏正文由 `highlight.mjs` 上色（注释 / 字符串 / 数字 / 关键字 / 字面量），语言取围栏自己的 info string（```` ```js ````、```` ```python ```` 之类，认 js/ts/json/python/bash/css/html 的常见别名），不认得就整块一种颜色。**每个代码块的语言选择器是一枚浮窗**（`public/js/fence-chips.js`）：平时隐形，指针进到代码块顶部才在右上角浮起，指针离开就收回去；浮起的竖直位置和**代码第一行同行**，这一行在哪、「顶部」算多深都由这个块自己的样式算出来（`padding-top` 加上正文的一行行高），样式表改动 padding 或行高，芯片自己跟着走，代码块也不再为它预留一条空带。代价是它浮起时会盖住第一行右端的文字，所以块里永远只有你在看的那一行被挡住。光标落到选择器自身上时它一定还浮着（伸手去点不会让它从光标下消失），选完语言重绘的那一帧是按「指针还在哪个围栏上」重新判定的，所以不会点一半闪掉；收起用的是 `opacity` 而不是 `display`，键盘 `Tab` 过去照样能聚焦，一聚焦就显形。它读的就是这个 info string，选一下也就是把这一个词写回围栏那一行，别的什么都不动；选择器浮在正文之上、不在 contenteditable 里，所以既不进文档文本，也不占 OT 位置，只读访客看到的是同一个标签但改不动。`.doc` 导出走同一个渲染器，颜色一并带走。
- **表格**：点 `table` 弹出 6×5 网格选择器，插入对齐好的 GFM 表格，第一个单元格随即选中默认表头——直接打字就替换掉它。光标进入单元格后出现第二条工具栏：上下插行、左右插列、删行删列、左/中/右对齐、`copy`（制表符分隔，可直接粘进电子表格）。走到最后一格自动补一行。新插入的列是空格子，不会造出重名表头；只移动光标永远不会改写一张参差表格的格式。
- **附件**：点 `attach`、把文件拖进正文、或直接粘贴（截图就靠粘贴）。第三栏面板展示缩略图、大小、时间和上传者，提供 `link`（复制可分享地址）和 `remove`（二次确认）。每次上传会在光标处独占一块插入引用：图片是 `![name](/files/…)`，其余是 `[📎 name](/files/…)`。
- **导出**：页脚 `export .md` 给模型原文，`export .doc` 给 Word 能直接打开的 HTML（内联样式覆盖标题、引用、代码、表格边框；Word 没有页面地址可解析相对路径，所以 `src`/`href` 会按请求来源补成绝对地址）。
- 远端光标与选区浮在正文之上（用 `Range.getClientRects()` 定位，一帧内多次变更只画一次），带账号名标签；顶栏显示在线成员与「N editing」。
- 断线重连或服务端 `stale` 重同步时，横幅会保留那份没发出去的本地改动，点 `restore` 才重新提交，不会覆盖别人的内容。

## 安全约束

- Markdown 渲染先转义再拼标签（代码高亮的每个片段也是先转义再包 `<span>`，颜色来自固定的五张色卡而不是文档内容），链接只放行 `http/https/mailto/ftp`、`#锚点` 和相对路径，拦截 `javascript:`、`data:`。语言选择器的浮层用 `createElement`/`textContent` 搭、不在 contenteditable 里，它往围栏那一行写的字符也必须过 `[\w.+-]` 这一关（渲染器不认的字符直接丢掉）。
- 身份不采信客户端的任何说法：名字来自 cookie 背后的账号，角色来自 `roleFor(doc, viewer)`，socket 的 `access` 每次快照都由存储的记录现推。查询串声称不了编辑权，`?mode=view` 链接也只能失去权限而不能获得。
- 共享名单要过校验（`assertGrants`）：最多 50 条，每条必须是存在的用户 id 加上 `editor` 或 `viewer`，重复的会被丢掉。`visibility` 只认 `public|private`。
- 账号名限定 `/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u`、2..32 个字符且在大小写不敏感下唯一；密码 8..512 个字符。同伴看到的显示名就是这同一个字段，所以标记、换行、控制字符都没法借它进到别人的浏览器。
- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`、`Max-Age` 30 天，请求为 HTTPS（含反代声明的 `x-forwarded-proto: https`）时加 `Secure`。所有改写类请求必须同源，比对 `Origin` 或 `Referer`。
- 同伴颜色在进入 `style` 前必须匹配 `/^#[0-9a-f]{3,8}$/i`。
- 文档 id 与附件 id 都限定 `/^[A-Za-z0-9_-]{1,40}$/`，静态文件服务校验解析后的路径仍在根目录内。附件路径只由这两个 id 拼出：上传的文件名只是元数据，永远不参与寻址。
- 上传的文件只有在白名单内（图片、PDF、`text/plain`）才允许内联渲染，其余一律 `application/octet-stream` + `Content-Disposition: attachment` + `x-content-type-options: nosniff`。也就是说，别人传上来的 `.html`、`.svg` 无法在本源上执行脚本。
- 导出的响应同样带 `nosniff`，文件名由标题经 `cleanName` 过滤得到；`.doc` 里的 `<style>` 是常量，用户内容一律走渲染器转义。
- 上限：单文档 500 000 字符、HTTP 请求体 1 MB、WS 帧 256 KB、单次编辑 ≤512 个组件且插入 ≤100 000 字符、`opLog` 512 条、单个附件 10 MB、单文档 50 个附件、单文档 50 条授权、每个账号 15 分钟内 5 次失败登录。

## 已知限制

- 注册是按设计敞开的：任何能连到这台服务器的人都能建账号、成为自己文档的 owner，所以信任边界是网络而不是邀请名单。不想这样就得放在反向代理、VPN 或防火墙后面。第一个账号是 admin，并且能在 owner 的位置上读每一篇文档：谁先注册谁管这个地方，请在开放端口之前先把这一步做掉。
- 没有改密码、没有重置、没有邮箱、没有第二步验证。admin 能停用账号，但读不到也换不掉它的密码；这是有意为之，代价是丢密码就等于换一个账号。
- 会话就是一个扁平 JSON 文件里绝对过期 30 天的令牌，不能轮换、不能缩短、也没绑定设备或 User-Agent：`doc_auth` cookie 一旦被抄走，这个窗口期内就是可用的。登出会删掉那一行，这是唯一的吊销手段（另一条是停用账号）。
- 登录限速在内存里、按进程、以你输入的名字为键：它拖慢猜密码，但对付分布式尝试不花钱，而且重启就清零。没有锁定、没有日志、没有告警。
- 共享是每篇文档最多 50 个命名账号的名单。没有分组，没有继承或团队级权限，没有「所有登录者都可编辑」，授权没有有效期，也没有「谁把什么共享给了谁」的审计记录。
- 吊销很快，但不是追溯性的：名单一变， socket 立刻重新鉴权，而文档此前的正文已经在别人的浏览器里。删除文档会连附件一起清掉，但没有任何东西能证明它还是 public 的时候被谁读过。
- `public` 文档对本服务器能连到的每个访客都可读——连导出、连正文里引用的附件字节也一样，无论对方有没有账号。`visibility` 不是一道密码。
- 高亮只认模式，不做解析：只有注释 / 字符串 / 数字 / 关键字 / 字面量这五类，靠一张按语言写好的表，没有语法树，所以字符串里的关键字、模板插值里的代码都不保证。颜色要等一次重画才落地——光标停在围栏里时，敲完约 0.45 秒的空档就补这次重画，所以边写边染色；光标离开围栏同样会补；正文里打字不会触发重画。围栏的语言只有 info string 一个来源，选择器提供 js / ts / json / python / bash / css / html 加「无语言」这几格，别的拼写（```` ```c++ ````、```` ```ruby ````）得手打或粘贴，选择器会照原样显示它、只是不上色。
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
server/hub.mjs         连接管理、协议、广播、在线重算权限
server/room.mjs        房间：提交、rebase、在线状态
server/store.mjs       JSON 文件存储
server/access.mjs      角色规则，单独一个纯函数模块
server/auth.mjs        scrypt、令牌、cookie、同源校验、登录限速
server/users.mjs       账号、首个注册者即 admin、最后一个 admin 的保护
server/sessions.mjs    token -> 账号，绝对过期，按账号清除
server/files.mjs       附件字节、内联/下载策略
server/export.mjs      .md / .doc 导出
shared/ot.mjs          OT 引擎（apply/makeEdit/compose/transformPair）
public/                大厅、编辑页、样式
public/js/editor.js    编辑页装配：输入、工具栏、表格操作、快捷键、按权限改外壳
public/js/serialize.mjs DOM <-> Markdown 双向桥 + 偏移映射
public/js/blocks.mjs   块级插入、选区替换与走出围栏的落点算术，围栏的位置与语言改写（纯函数）
public/js/fence-chips.js 每个代码块一枚语言选择器，悬停在块顶时与代码第一行一同浮出
public/js/highlight.mjs 围栏正文分词（纯文本进、带类别的片段出）
public/js/outline.mjs  从模型文本读标题树（纯函数）
public/js/outline.js   大纲栏：折叠、跳转、当前小节高亮
public/js/markdown.mjs 渲染器（纯字符串，服务端导出复用）
public/js/table.mjs    GFM 表格模型（纯文本进、纯文本出）
public/js/session.js   socket：OT 客户端状态，以及服务端给出的 `access`
public/js/sharing.js   共享面板：可见性与授权名单
public/js/presence.js  同伴光标层
public/js/attachments.js  上传、附件面板、Markdown 引用
test/ · shared/*.test  存储/附件/房间/导出/账号权限/端到端/OT/序列化/块级插入/围栏与语言选择器/表格/大纲/光标层测试
test/client.mjs        一个 cookie jar 加一个 `ws` 客户端，让测试能同时扮演几个人
```

依赖仅 `ws`。Node ≥ 22.13。MIT。
