# doc-online

A real-time multiplayer Markdown document editor: one what-you-see-is-what-you-get surface, Confluence-style attachments and in-document tables, plus `.md` / `.doc` export. No frameworks: Node's own `http` + `ws`, native ES modules in the browser, and a hand-written OT (operational transformation) engine settling conflicts.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
PORT=4000 npm start
npm test           # node --test, 88 cases
```

Open <http://localhost:3000> to create or open a document, then hand out the `share link` / `read-only link` from the top bar (`?mode=view` — the server refuses writes on that connection). Identity (clientId, display name) lives in `localStorage`; opening a second tab in the same browser takes over the first one (it receives `kicked`, says so, and turns read-only).

## What you see is what you get

There is no source pane and no "preview" concept: Markdown is the model, the contenteditable tree on screen is its view.

- **The bridge** is `public/js/serialize.mjs`: `renderMarkdown(text)` paints the DOM, `serializeDocument(root)` reads text back plus a node → character-offset table. The round trip is idempotent — `serialize(render(x))` reaches a fixed point in one pass.
- **The caret lives in Markdown offsets** (`{start,end}`), so a remote op can shift it with `transformPosition` and the surface restores the matching DOM position after a repaint. Peer selections go the other way: offsets → Range rectangles.
- **One walk writes global offsets**: a block emits its own prefix (`# `, `> `, `- `, `` ``` ``) before recording `begin`, so `marks.get(node).start` is always where that node's content starts. Table cells are written one at a time using the same padding helpers as `serializeTable`, which is why a row typed into the grid is byte-identical to one built from the model.
- **Where a block lands** is pure arithmetic in `public/js/blocks.mjs`: a caret in the middle of a sentence makes the block wait for the line to end, and it gets a blank line on each side; a caret inside a code fence or a table pushes the insert past the whole block (`blockEndForCaret()`), so a fence or a row can never be cut in two.
- **Outline jumps resolve through the offset table**: a rail row points at the start of its heading line (the `#`), while `marks.get(heading).start` is where that heading's text begins — the two differ by the prefix. So clicking a row first looks the heading up in `marks`, then calls `placeCaret`, instead of letting two coordinate systems disagree.
- **Composition never repaints**: `compositionstart` records the base text, `compositionend` commits the whole result as a single `makeEdit`, so a peer edit cannot replace the DOM mid-pinyin.
- **Undo is application-level** (`Cmd/Ctrl` + `Z`, `Shift+Z`, `Y`): an innerHTML repaint leaves the browser's native undo stack pointing at dead nodes.
- Whole-block commands (heading, quote, list) refuse to run inside a code block or a cell and say why; inline commands (bold, italic, strikethrough, code, link) are always allowed.

## Collaboration model

- **A document is a plain string**, and operations transform only that string; rich structure (tables, images, code) is markup inside it.
- **An operation** is a component array: `{retain:n}` / `{insert:"s"}` / `{delete:n}`, with positions implied by the base length each component consumes.
- **Total coverage is the contract**: every op must read the whole base document (retaining to the end explicitly). `apply()` validates it, so a lagging client fails loudly instead of silently misplacing text. The client's `makeEdit(before, after)` satisfies it by construction.
- **The server orders everything**: a room commits in arrival order and `revision` only grows. A client tracks its confirmed `revision` plus a FIFO `pending` queue, and sends `baseRevision = revision + pending.length - 1`.
- **On a concurrent op**, each unconfirmed local op is rewritten with `transformPair(pending, remote)`, where `theirs` feeds the remote result in; both sides converge on the same text.
- **On a stale op**, the server rebases it across `opLog` (the last 512 ops) — with simultaneous inserts, the earlier commit lands first. Past the log it replies `stale`, the client pulls a snapshot and carries its unconfirmed edits back with it, so nothing typed is lost.
- **`ack` carries the document length**: a mismatch triggers a `resync` rather than accumulating drift.
- **Tables and attachments ride the same wire**: a table is GFM text and every toolbar action rewrites the block and sends it as an ordinary edit; attachment bytes never enter the document, only the `/files/<docId>/<fileId>` reference.

## Protocol

WebSocket: `/ws?doc=<id>&client=<1..32 chars of [A-Za-z0-9_-]>&name=<display name>[&mode=view]`, JSON envelopes, one intent per message.

| Direction | Messages |
| --- | --- |
| client → server | `edit {seq, baseRevision, op}`, `presence {selection:{start,end}, typing}`, `title {title}`, `resync`, `ping {at}` |
| server → client | `doc {id,title,text,revision,files,updatedAt,users}`, `ack {seq,revision,length}`, `op {from,revision,op}`, `users {users}`, `title {title}`, `files {files}`, `stale {…doc,reason}`, `kicked`, `error {message,code?}`, `pong {at}` |

HTTP: `GET /api/health`, `GET|POST /api/docs`, `GET|PATCH|DELETE /api/docs/:id` (`GET` prefers the live in-memory text), `GET /api/docs/:id/export?format=md|doc`, `GET|PUT /api/docs/:id/files` and `DELETE /api/docs/:id/files/:fileId` for attachments, `GET /files/:docId/:fileId[/<name>]` to download one.

An upload is a raw-byte `PUT` with name/type/uploader in the query string (`?name=&type=&who=`), so no upload library is needed. Only metadata then broadcasts to every peer (including the uploader) over `files`; binary never crosses the WebSocket.

## Data and persistence

JSON on disk, no database:

```
data/index.json                     # document catalogue (id/title/revision/fileCount/timestamps)
data/docs/<id>.json                 # one full document + attachment metadata
data/attachments/<docId>/<fileId>   # attachment bytes, no extension
```

Writes go through a temp file + rename, per-document writes are serialised on a Promise chain, and shutdown (SIGINT/SIGTERM) closes connections and `flush()`es before exiting. `data/` is gitignored. Deleting a document clears its attachment directory too.

## Interface

- One centred column (760px) and a toolbar holding everything: bold / italic / strikethrough / inline code / link / H1 / H2 / quote / bullet list / numbered list / body text / divider / code block / table / attach. An empty document shows a single line of guidance, which the first keystroke replaces.
- **Outline rail** down the left: `public/js/outline.mjs` reads the headings straight out of the model text (a `#` inside a fence does not count), so every row matches some `<hN>` on the page, and rows indent by how deeply they nest rather than by heading level. The arrow beside a label folds that section's own subtree and nothing else; which headings you folded is stored per document in `localStorage` — it is your view of the text, never on the wire. Clicking a label puts the caret on that heading and scrolls it into view, and as the caret moves the section you are in stays highlighted. A read-only page can fold and jump as well. `«` at the head of the rail collapses it to a 34px strip, `»` on the strip brings it back, remembered in `localStorage` too. Under 860px of window width the rail hides.
- Shortcuts: `Cmd/Ctrl` + `B` `I` `E` `K`; `Cmd/Ctrl` + `Z` / `Shift+Z` / `Y` for undo/redo; `Tab` / `Shift+Tab` walks cells (and inserts two spaces outside a table); `Enter` inside a table behaves like `Tab`. Other block structure is left to the browser's contenteditable behaviour and normalised back into text by the serializer. Pasted markup always arrives as plain text.
- **Tables**: `table` opens a 6×5 grid picker; the inserted GFM table immediately selects the first header cell's default label, so typing replaces it. With the caret in a cell, a second toolbar appears: rows above/below, columns before/after, delete row/column, left/centre/right align, and `copy` (tab-separated, pastes straight into a spreadsheet). Walking past the last cell appends a row. An inserted column comes in blank rather than with a duplicate header, and moving the caret never reformats a ragged table.
- **Attachments**: the `attach` button, dragging files onto the text, or pasting (that is how screenshots arrive). The side panel shows thumbnails, size, age and uploader with `link` (copy a shareable URL) and `remove` (confirm twice). Each upload claims its own block at the caret: `![name](/files/…)` for images, `[📎 name](/files/…)` for anything else.
- **Export**: `export .md` gives the model text; `export .doc` gives Word-openable HTML with inline styles for headings, quotes, code and table borders. Word has no page URL to resolve site-relative references against, so `src`/`href` are rewritten to absolute using the request origin.
- Peer carets and selections float above the text (positioned from `Range.getClientRects()`, painted at most once per frame) with name labels; the top bar lists who is here and says "N editing".
- On reconnect or a `stale` resync, the banner keeps the local change that never got sent; pressing `restore` re-submits it instead of overwriting other people.

## Security constraints

- The renderer escapes first and only then assembles tags; links allow `http/https/mailto/ftp`, `#anchors` and relative paths, and block `javascript:` and `data:`.
- Peer colours must match `/^#[0-9a-f]{3,8}$/i` before they reach a `style`.
- Document and file ids are both `/^[A-Za-z0-9_-]{1,40}$/`, and static serving checks that the resolved path stayed inside the root. Attachment paths are built only from those two ids: the uploaded filename is metadata and never part of addressing.
- Uploads render inline only inside an allowlist (images, PDF, `text/plain`); anything else comes back as `application/octet-stream` with `Content-Disposition: attachment` and `x-content-type-options: nosniff`, so somebody's `.html` or `.svg` cannot run scripts on this origin.
- Export responses carry `nosniff`, filenames come from the title through `cleanName`, and the `.doc` `<style>` block is a constant — user content always goes through the escaping renderer.
- Limits: 500 000 characters per document, 1 MB HTTP body, 256 KB WS frame, ≤512 components and ≤100 000 inserted characters per edit, 512 entries in `opLog`, 10 MB per attachment, 50 attachments per document.

## Known limitations

- No accounts: anyone with the link can edit, and read-only links rely on the `mode=view` convention — the server only refuses writes from that connection. Uploads are REST and belong to no connection, so a read-only page merely hides the buttons; there is no identity to authorize against.
- Positions count UTF-16 code units, so a surrogate pair (emoji) can be split.
- The OT engine handles plain-text insert/delete only: no rich-text attributes, no offline multi-device merge. What the WYSIWYG surface can express is exactly the Markdown the renderer supports — colour, font size and merged cells are not in the document model.
- The view depends on the browser's own contenteditable behaviour; the differences between engines in Enter, delete and paste are absorbed by the serializer, which reads back the same text. The one normalisation cost: trailing newlines are trimmed, so each document spends one broadcast settling it.
- Two people driving the same table's toolbar merge as text and can interleave rows and columns — table blocks are not locked.
- The rail lists ATX headings at the start of a line only: setext headings (`===` / `---` underlines) and a `> # heading` inside a quote never appear there. Same text at the same level counts as one section, so the two fold together; folding the section the caret happens to be in moves the highlight to its nearest visible ancestor.
- `.doc` is Word-HTML, not OOXML (a dependency-free server has no business shipping a zip writer), and its images and attachment links only appear while the server is still reachable.
- Single-process in-memory rooms; scaling out needs an extra broadcast layer.

## Layout

```
server.js              HTTP + WS entry point
server/hub.mjs         connections, protocol, broadcast
server/room.mjs        room: commits, rebasing, presence
server/store.mjs       JSON file store
server/files.mjs       attachment bytes, inline/download policy
server/export.mjs      .md / .doc export
shared/ot.mjs          OT engine (apply/makeEdit/compose/transformPair)
public/                lobby, editor page, styles
public/js/editor.js    editor page: input, toolbar, table ops, shortcuts
public/js/serialize.mjs DOM <-> Markdown bridge with offset mapping
public/js/blocks.mjs   where a block lands (pure functions)
public/js/outline.mjs  heading tree read from the model text (pure functions)
public/js/outline.js   the rail: folding, jumping, highlighting the current section
public/js/markdown.mjs renderer (pure string, reused by server export)
public/js/table.mjs    GFM table model (text in, text out)
public/js/presence.js  peer caret overlay
public/js/attachments.js  upload, panel, Markdown references
test/ · shared/*.test  store/attachments/room/export/e2e/OT/serialize/blocks/table/outline/caret tests
```

The only dependency is `ws`. Node ≥ 22.13. MIT.
