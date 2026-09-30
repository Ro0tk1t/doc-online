# doc-online

A real-time multiplayer Markdown document editor: one what-you-see-is-what-you-get surface, Confluence-style attachments and in-document tables, accounts with per-document permissions, plus `.md` / `.doc` export. No frameworks: Node's own `http` + `ws`, native ES modules in the browser, a hand-written OT (operational transformation) engine settling conflicts, and `node:crypto` for passwords and session tokens.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
PORT=4000 npm start
npm test           # node --test, 146 cases
```

Open <http://localhost:3000> and sign up. **The first account on an empty server becomes the admin**, and registration stays open after that, so this is a place for a team you invite, not a public SaaS. Creating a document takes an account; reading a `public` one does not.

Identity is the `doc_auth` cookie the server sets — nothing about who you are is read from `localStorage` or a query string. `?mode=view` still narrows a link to read-only, but it is now a hint the server may override with a stricter answer, never a permission it grants. The top bar's `sharing` button (owners only) decides visibility and who is on the list.

## Accounts and permissions

Four roles per document, decided in one pure function (`server/access.mjs`), plus one account-level role:

| Role | How you get it | What you may do |
| --- | --- | --- |
| `owner` | you created the document, or you are an admin | read, write, rename, delete, change sharing |
| `editor` | put on the share list by an owner | read, write, attach and remove files |
| `viewer` | put on the share list by an owner | read, export, copy links — no writes |
| `reader` | anonymous on a `public` document | read, export — no writes, and no share list |
| — | anyone not covered above, on a `private` document | nothing; the socket is refused |

- **`visibility`** is `private` (default) or `public`. Public means the whole world can read that one document; it never makes anybody an editor.
- **`admin`** is an account role, not a document role: an admin resolves to `owner` on every document, which is what makes a stuck or orphaned document recoverable. Admins see an `Accounts` panel in the lobby to promote, demote, disable and re-enable people. The last remaining admin can be neither demoted nor disabled, because that would leave the server with nobody who could undo it.
- **Every snapshot the socket sends carries this visitor's own `access` block**, so the page never has to work out its rights — two people can sit in one room with different answers, and a share change mid-session reaches both of them (the demoted peer gets a fresh snapshot, a revoked one gets closed with `4003`).
- **The rules are enforced in three places at once**: the REST route (`requireRole`), the WebSocket handshake (`roleFor` before the room is joined), and every write inside the room. Hiding a button is never the check.
- **Passwords** are scrypt (`N=16384, r=8, p=1`) with a 16-byte per-user salt, compared with `timingSafeEqual`. An unknown name still costs a full scrypt run, so a wrong name and a wrong password take the same time.
- **Sessions** are opaque 24-byte random tokens in `data/sessions.json` with an absolute 30-day expiry — no sliding refresh, so revocation is deleting one row. Disabling an account drops its sessions immediately.
- **Login throttling** is in-memory, per account name: 5 failures in 15 minutes starts a 30-second wait that grows by 30 seconds per further failure. It is a speed bump, and a restart clears it.
- **CSRF**: the cookie is `HttpOnly; SameSite=Lax`, and every mutating request is additionally checked against the request's own `Origin`/`Referer`, because Lax does not cover a top-level POST. `Secure` is added when the connection is TLS or `x-forwarded-proto: https`.


## What you see is what you get

There is no source pane and no "preview" concept: Markdown is the model, the contenteditable tree on screen is its view.

- **The bridge** is `public/js/serialize.mjs`: `renderMarkdown(text)` paints the DOM, `serializeDocument(root)` reads text back plus a node → character-offset table. The round trip is idempotent — `serialize(render(x))` reaches a fixed point in one pass.
- **The caret lives in Markdown offsets** (`{start,end}`), so a remote op can shift it with `transformPosition` and the surface restores the matching DOM position after a repaint. Peer selections go the other way: offsets → Range rectangles.
- **One walk writes global offsets**: a block emits its own prefix (`# `, `> `, `- `, `` ``` ``) before recording `begin`, so `marks.get(node).start` is always where that node's content starts. Table cells are written one at a time using the same padding helpers as `serializeTable`, which is why a row typed into the grid is byte-identical to one built from the model.
- **Where a block lands** is pure arithmetic in `public/js/blocks.mjs`: a caret in the middle of a sentence makes the block wait for the line to end, and it gets a blank line on each side; a caret inside a code fence or a table pushes the insert past the whole block (`blockEndForCaret()`), so a fence or a row can never be cut in two. Stepping *out* of a fence is decided in the same layer (`planFenceExit()`), which looks only at whether the caret's own line is empty and whether any code is left under it.
- **A break inside a fence is a position**: the browser turns Enter typed into code into a `<br>`, which is not a text node, so a caret offset could only fall back to the end of the line above it -- a line earlier than the one on screen. The serializer now marks every break a fence actually writes (`Writer.nl(breaks, node)`), so an empty line reads back as itself. Breaks in prose are untouched: a `<br>` an absorbed break produces no text at all, so there is no position to mark.
- **A block command owns whole lines**: with text selected, `block` (or `code` across a line break) runs `linesSpan()` to widen the selection to every line it touches and `planReplace()` to swap those lines for the new block, blank lines mended on each side. A caret resting on a line with nothing selected still just drops an empty block underneath it, so a sentence is never swallowed into a code block.
- **Highlighting is the renderer's business**: `public/js/highlight.mjs` cuts a fence body into five kinds of piece (comment, string, number, keyword, literal) and `renderMarkdown` wraps each in a coloured `<span>`. Not one character of text changes, so `serialize` reads back exactly the same Markdown — colour never enters the document model and never occupies a position in the OT stream.
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

WebSocket: `/ws?doc=<id>&client=<1..32 chars of [A-Za-z0-9_-]>[&mode=view]`, JSON envelopes, one intent per message. The session cookie rides the handshake, and the name the `name=` parameter used to carry is gone: a peer is named by their account, and an anonymous one by `Guest <clientId prefix>`. Opening a second tab with the same `client` id still takes the first one over (`kicked`).

| Direction | Messages |
| --- | --- |
| client → server | `edit {seq, baseRevision, op}`, `presence {selection:{start,end}, typing}`, `title {title}`, `resync`, `ping {at}` |
| server → client | `doc {id,title,text,revision,files,updatedAt,users,owner,visibility,access}`, `ack {seq,revision,length}`, `op {from,revision,op}`, `users {users}`, `title {title}`, `files {files}`, `stale {…doc,reason}`, `kicked`, `error {message,code?}`, `pong {at}` |

`access` is `{role, canEdit, canManage, intent}` for this connection only, never for the room. A handshake the rights do not cover is refused with close code `4003` and an `error` whose `code` is `need_login` (anonymous) or `forbidden` (signed in but not on the list); the client stops reconnecting on that code.

HTTP: `POST /api/signup`, `POST /api/login`, `POST /api/logout`, `GET /api/me` (who I am, and whether this server has any accounts yet), `GET /api/users?q=` (name search for the share panel, signed in only), `GET|POST /api/admin/users[/:id]` (admin: list, promote, demote, disable, re-enable), `GET /api/health`, `GET|POST /api/docs`, `GET|PATCH|DELETE /api/docs/:id`, `GET|PUT /api/docs/:id/access`, `GET /api/docs/:id/export?format=md|doc`, `GET|PUT /api/docs/:id/files` and `DELETE /api/docs/:id/files/:fileId` for attachments, `GET /files/:docId/:fileId[/<name>]` to download one.

`POST /api/docs` and a `PUT` of the share list need an account (`401 need_login`) and the rights on the document (`403` with a code: `forbidden`, `read_only`, `not_owner`). Who may see a document is decided before its text is read, so an unauthorized `GET`, `export`, or attachment fetch is a `403`/`401` and never a byte. The share list itself is not part of a document's readable content: `grants` comes back only for an owner, and `GET /api/docs/:id/access` requires an account even on a public document.

An upload is a raw-byte `PUT` with name and type in the query string (`?name=&type=`), so no upload library is needed; the uploader recorded on the file is whoever the cookie says, not whatever the request claims. Only metadata then broadcasts to every peer (including the uploader) over `files`; binary never crosses the WebSocket.

## Data and persistence

JSON on disk, no database:

```
data/index.json                     # document catalogue (id/title/revision/fileCount/timestamps)
data/docs/<id>.json                 # one full document + attachment metadata + owner/visibility/grants
data/attachments/<docId>/<fileId>   # attachment bytes, no extension
data/users.json                     # accounts: id, name, scrypt salt+hash, role, disabled, createdAt
data/sessions.json                  # token -> {user, at}, with an absolute expiry
```

Writes go through a temp file + rename, per-document writes are serialised on a Promise chain, and shutdown (SIGINT/SIGTERM) closes connections and `flush()`es before exiting. `data/` is gitignored. Deleting a document clears its attachment directory too. A password hash never leaves `server/users.mjs`: everything above it sees the public projection (`id`, `name`, `role`, `disabled`, `createdAt`).

A document record gained `owner`, `visibility` and `grants` alongside its text, so the whole store stays one folder of JSON. Earlier data with no owner is not migrated: put it in `data/legacy/` and start from an empty server, because an ownerless document has no answer to "who may share this".


## Interface

- **Who you are, right there in the bar**: the top bar shows this visitor's role as a badge (`owner` / `editor` / `viewer`, or `read-only` for an anonymous reader), and an anonymous reader gets a `sign in to edit` link back to the lobby with this document already filled in. Your own presence chip carries the account name the server answered with, so nobody can name themselves somebody else.
- **Sharing** (owners only) hangs under the bar's `sharing` button: a private/public switch, the owner line, one row per granted account with its own `can edit` / `can read` selector and a `remove` button, and an add field that looks accounts up by exact name (case-insensitive). Every change is a whole-list `PUT`, and the peers already in the room re-derive their rights from it within one message.
- One centred column (760px) and a toolbar holding everything: bold / italic / strikethrough / inline code / link / H1 / H2 / H3 / H4 / H5 / quote / bullet list / numbered list / body text / divider / code block / table / image / attach. An empty document shows a single line of guidance, which the first keystroke replaces. The lobby hides `New document` and the read-only link generation from a visitor it cannot let write.
- **Outline rail** down the left: `public/js/outline.mjs` reads the headings straight out of the model text (a `#` inside a fence does not count), so every row matches some `<hN>` on the page, and rows indent by how deeply they nest rather than by heading level. The arrow beside a label folds that section's own subtree and nothing else; which headings you folded is stored per document in `localStorage` — it is your view of the text, never on the wire. Clicking a label puts the caret on that heading and scrolls it into view, and as the caret moves the section you are in stays highlighted. A read-only page can fold and jump as well. `«` at the head of the rail collapses it to a 34px strip, `»` on the strip brings it back, remembered in `localStorage` too. Under 860px of window width the rail hides.
- Shortcuts: `Cmd/Ctrl` + `B` `I` `E` `K`; `Cmd/Ctrl` + `Z` / `Shift+Z` / `Y` for undo/redo; `Tab` / `Shift+Tab` walks cells (and inserts two spaces outside a table); `Enter` inside a table behaves like `Tab`. Other block structure is left to the browser's contenteditable behaviour and normalised back into text by the serializer. Pasted markup always arrives as plain text.
- **Code blocks**: `block` moves the selected lines inside a fence (with no selection it still only adds an empty block under the current line) and puts the caret inside, so Enter is another line of code. **The second Enter on an empty line leaves the block**: a break inside a fence belongs to the code, and only an empty caret line with no code under it -- in a block of at least two lines -- counts as getting out. So the first Enter in a fresh block means "start writing code", the second one leaves; a blank line in the middle of a multi-line body stays code. A block that never held anything goes with the exit rather than staying behind as an empty shell, and when the exit lands on the last block in the document Markdown has no way to say an empty paragraph after it, so the surface keeps a temporary `<p><br></p>` to catch the caret -- it types out as a real paragraph. Inline `code` (`Cmd/Ctrl` + `E`) writes the backticks into the model, and the same command again takes them off; a selection crossing a line upgrades to a code block, because a Markdown inline span cannot hold a line break — writing one there used to lose both the break and the markup. Enter inside an inline span now closes the span first: the browser used to drag the `<code>` element onto the new line, which formatted the prose below it as code, and splitting an empty span left backticks that never closed. A fence body gets its colours from `highlight.mjs`, and the language is the fence's own info string (```` ```js ````, ```` ```python ````, with the usual aliases for js/ts/json/python/bash/css/html); anything unknown stays one flat colour. **The language selector on a code block is a floating control** (`public/js/fence-chips.js`): it stays invisible until the pointer comes to the top of the block, and then lifts up in its top-right corner, and the pointer leaving puts it away. It rides the block's **first line of code**, and both where that line sits and how far down the pointer still counts as being at the top are measured from the block's own styles -- its `padding-top` plus one line of its text -- so moving the padding or the leading in the stylesheet moves the chip along, and a block no longer keeps an empty band for it. The cost is that a lifted chip covers the right-hand end of that first line, so the most that is ever hidden is the one line you are looking at. A pointer that has reached the selector keeps it up -- reaching for the language must not make it vanish under the cursor -- and the frame that repaints after a pick decides again by which *fence* the pointer is on, so a chip never flickers away mid-click. It fades with `opacity` rather than switching off with `display`, so `Tab` still reaches it and focusing it reveals it. It reads that very info string, and choosing a language writes one word back into the fence's own line and nothing else. The chip floats over the text instead of living in the contenteditable, so it never enters the document and never takes a position in the OT stream; a read-only visitor sees the same label with the choice taken away. `.doc` export runs through the same renderer, so it carries the colours too.
- **Tables**: `table` opens a 6×5 grid picker; the inserted GFM table immediately selects the first header cell's default label, so typing replaces it. With the caret in a cell, a second toolbar appears: rows above/below, columns before/after, delete row/column, left/centre/right align, and `copy` (tab-separated, pastes straight into a spreadsheet). Walking past the last cell appends a row. An inserted column comes in blank rather than with a duplicate header, and moving the caret never reformats a ragged table.
- **Attachments**: the `image` button takes pictures only -- `accept="image/*"`, and the picked files are checked again, so a non-image that slips through the dialog is refused with a word about `attach` rather than quietly stored; the `attach` button takes anything, and dragging files onto the text or pasting works too (that is how screenshots arrive). The side panel shows thumbnails, size, age and uploader with `link` (copy a shareable URL) and `remove` (confirm twice). Each upload claims its own block at the caret: `![name](/files/…)` for images, `[📎 name](/files/…)` for anything else.
- **Export**: `export .md` gives the model text; `export .doc` gives Word-openable HTML with inline styles for headings, quotes, code and table borders. Word has no page URL to resolve site-relative references against, so `src`/`href` are rewritten to absolute using the request origin.
- Peer carets and selections float above the text (positioned from `Range.getClientRects()`, painted at most once per frame) with the account name as its label; the top bar lists who is here and says "N editing".
- On reconnect or a `stale` resync, the banner keeps the local change that never got sent; pressing `restore` re-submits it instead of overwriting other people.

## Security constraints

- The renderer escapes first and only then assembles tags (each highlighting piece is escaped before it is wrapped in a `<span>`, and the colour comes from a fixed five-value palette rather than the document), so untrusted collaborator text cannot inject script here. Links allow `http/https/mailto/ftp`, `#anchors` and relative paths, and block `javascript:` and `data:`. The language chips are built with `createElement`/`textContent` in a layer outside the contenteditable, and the only thing one can write into a fence's line is a word that survives the `[\w.+-]` filter the renderer accepts.
- Nothing about identity is taken from the client: the name comes from the account behind the cookie, the role comes from `roleFor(doc, viewer)`, and the socket's `access` block is derived from the stored record on every snapshot. A query string cannot claim an editor's rights, and a `?mode=view` link can only ever lose them.
- Grants are validated (`assertGrants`): at most 50 entries, each an existing user id plus `editor` or `viewer`, duplicates dropped. Visibility is validated against exactly `public|private`.
- Names are `/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u` at 2..32 characters and unique case-insensitively; passwords are 8..512 characters. The display name peers see is that same field, so no markup, newline or control character can reach another browser through it.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, 30-day `Max-Age`, `Secure` whenever the request is HTTPS (including behind a proxy that sets `x-forwarded-proto`). Mutating requests must be same-origin, checked from `Origin` or `Referer`.
- Peer colours must match `/^#[0-9a-f]{3,8}$/i` before they reach a `style`.
- Document and file ids are both `/^[A-Za-z0-9_-]{1,40}$/`, and static serving checks that the resolved path stayed inside the root. Attachment paths are built only from those two ids: the uploaded filename is metadata and never part of addressing.
- Uploads render inline only inside an allowlist (images, PDF, `text/plain`); anything else comes back as `application/octet-stream` with `Content-Disposition: attachment` and `x-content-type-options: nosniff`, so somebody's `.html` or `.svg` cannot run scripts on this origin.
- Export responses carry `nosniff`, filenames come from the title through `cleanName`, and the `.doc` `<style>` block is a constant — user content always goes through the escaping renderer.
- Limits: 500 000 characters per document, 1 MB HTTP body, 256 KB WS frame, ≤512 components and ≤100 000 inserted characters per edit, 512 entries in `opLog`, 10 MB per attachment, 50 attachments per document, 50 grants per document, 5 failed logins per account per 15 minutes.

## Known limitations

- Registration is open by design, so anybody who can reach the server can create an account and become the owner of their own documents — the trust boundary is the network, not the invite list. Put it behind a reverse proxy, a VPN or a firewall if that is not what you want. The first account is the admin and can read every document as its owner: whoever signs up first runs this place, so do it before opening the port.
- There is no password change, no reset, no e-mail and no second factor. An admin can disable an account but cannot read or replace its password; that is deliberate, and it means a lost password is a new account.
- Sessions live in one flat JSON file with an absolute 30-day expiry, so a token is a bearer credential that cannot be rotated, shortened, or bound to a device or User-Agent; a stolen `doc_auth` cookie is good for the rest of that window. Logout deletes the row, which is the only revocation there is (disabling the account is the other).
- The login throttle is in memory and per process, keyed by the name that was typed: it slows down guessing but costs nothing to a distributed attempt, and an attacker who can restart the server resets it. There is no lockout, no log and no alert.
- Sharing is a per-document list of at most 50 named accounts. There are no groups, no inherited or team-wide permissions, no "anyone with an account can edit", no expiry on a grant, and no audit trail of who shared what with whom.
- Revocation is fast but not retroactive: a socket is re-authorized the moment the list changes, while a document's earlier text is already in another person's browser. Deleting a document clears its files, but nothing proves who read it while it was public.
- A `public` document is readable — and exportable, with the attachment bytes behind it — by every visitor this server can reach, whether or not they have an account. `visibility` is not a password.
- Highlighting matches patterns, it does not parse: five token classes from a per-language table, no grammar tree, so a keyword inside a string or an interpolation inside a template is not honoured. Colour lands on a repaint: with the caret resting inside a fence, about 0.45s after the last keystroke that repaint comes, so a line gets coloured while it is being written; leaving the fence settles it too, and typing prose never repaints. The fence's language has one source, its info string, and the chip offers js / ts / json / python / bash / css / html plus "plain"; any other spelling (```` ```c++ ````, ```` ```ruby ````) has to be typed or pasted, and the chip then shows that name as it is and leaves the block uncoloured.
- Positions count UTF-16 code units, so a surrogate pair (emoji) can be split.
- The OT engine handles plain-text insert/delete only: no rich-text attributes, no offline multi-device merge. What the WYSIWYG surface can express is exactly the Markdown the renderer supports — colour, font size and merged cells are not in the document model.
- The view depends on the browser's own contenteditable behaviour; the differences between engines in Enter, delete and paste are absorbed by the serializer, which reads back the same text. The one normalisation cost: trailing newlines are trimmed, so each document spends one broadcast settling it.
- Two people driving the same table's toolbar merge as text and can interleave rows and columns — table blocks are not locked.
- The rail lists ATX headings at the start of a line only: setext headings (`===` / `---` underlines) and a `> # heading` inside a quote never appear there. Same text at the same level counts as one section, so the two fold together; folding the section the caret happens to be in moves the highlight to its nearest visible ancestor.
- `.doc` is Word-HTML, not OOXML (a dependency-free server has no business shipping a zip writer), and its images and attachment links only appear while the server is still reachable.
- Single-process in-memory rooms; scaling out needs an extra broadcast layer.

## Layout

```
server.js              HTTP + WS entry point, routing, per-route access guards
server/hub.mjs         connections, protocol, broadcast, live re-authorization
server/room.mjs        room: commits, rebasing, presence
server/store.mjs       JSON file store
server/access.mjs      the role rules, in one pure module
server/auth.mjs        scrypt, tokens, cookies, same-origin check, login throttle
server/users.mjs       accounts, first-user-admin, last-admin guard
server/sessions.mjs    token -> account, absolute expiry, drop per account
server/files.mjs       attachment bytes, inline/download policy
server/export.mjs      .md / .doc export
shared/ot.mjs          OT engine (apply/makeEdit/compose/transformPair)
public/                lobby, editor page, styles
public/js/editor.js    editor page: input, toolbar, table ops, shortcuts, access-driven chrome
public/js/serialize.mjs DOM <-> Markdown bridge with offset mapping
public/js/blocks.mjs   where a block lands, what a selection replaces, where the fences are, how to leave one (pure functions)
public/js/fence-chips.js one language selector per code block, floating up on its first line while the pointer is at the top
public/js/highlight.mjs fence body tokenising (text in, tagged pieces out)
public/js/outline.mjs  heading tree read from the model text (pure functions)
public/js/outline.js   the rail: folding, jumping, highlighting the current section
public/js/markdown.mjs renderer (pure string, reused by server export)
public/js/table.mjs    GFM table model (text in, text out)
public/js/session.js   the socket: OT client state, and the server's `access` answer
public/js/sharing.js   the share panel: visibility and grant list
public/js/presence.js  peer caret overlay
public/js/attachments.js  upload, panel, Markdown references
test/ · shared/*.test  store/attachments/room/export/auth/e2e/OT/serialize/blocks/fences and language chips/table/outline/caret tests
test/client.mjs        a cookie jar plus a `ws` client, so tests can be several people
```

The only dependency is `ws`. Node ≥ 22.13. MIT.
