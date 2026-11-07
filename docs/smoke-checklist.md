# Manual Smoke Checklist

Real serial I/O stays outside automated tests by decision (spec issue #1,
Testing Decisions); webview DOM behavior is covered by the happy-dom suite
(`test/webviewPanes.test.ts`, which amends that decision), so this checklist
focuses on what only a live serial session and a real screen can verify.
The browser preview (`npm run preview:webview`) can drive most of the DOM
checks without a port. Everything serial below runs against a
**virtual COM pair** (com0com `COM10 ↔ COM11`, plus the second pair
`COM12 ↔ COM13` used for split view); a real device + USB adapter can
substitute either end at any time.

Setup:

```bash
npm run build          # or F5 (Launch Serial Monitor) which builds first
npm run smoke:device -- --port COM11 --scenario <scenario>   # feeds COM10
npm run smoke:device -- --port COM13 --scenario duo          # feeds COM12
```

Open the monitor: bottom panel → SERIAL MONITOR tab (or `Serial Monitor: Open Monitor`).

## Panes & starting monitors

- [ ] Empty state shows one controls row (＋ refresh filter timestamps log-dir open-file tag manage) with `Idle`
- [ ] **＋** opens a port quick-pick listing friendly names; picking COM10 opens a pane (yellow dot → green) streaming `lines` data
- [ ] The pane bar carries its own serial config: `[●] [COM10 ▾] [115200] [8 ▾] [none ▾] [1 ▾] [LF ▾]` — port picker lists every port; picking another port while connected moves the pane (ADR-0005 amendment)
- [ ] Each pane also carries its own global controls (＋ refresh filter timestamps log-dir open-file tag manage) and its own status (`Connected`) — nothing moves when you click the other pane
- [ ] **＋** again → pick COM12 → the view splits into two streaming panes; picking an already-monitored port focuses its pane instead of failing

## Base monitor (per pane)

- [ ] **▶/⏹** in the pane bar stops the stream and frees the port; ▶ restarts with the pane's own settings
- [ ] Change **baud / data bits / parity / stop bits while connected** → the port reopens live with the new settings (same pane, buffer intact); a param the device side doesn't match shows garbage rather than breaking
- [ ] Changing baud updates the recent-baud list; ＋'s quick-pick clones the newest pane's settings
- [ ] Stopped pane keeps its buffer; ▶ restarts and (on success) a fresh pane takes its place (it appears at the end of the strip)
- [ ] Port list refresh (🔄) keeps every pane's port select current

## Send (per pane)

- [ ] **⌨** expands the send bar (collapsed by default); placeholder names the port
- [ ] Send input + Enter sends with the pane's **Line ending** (`crlf` scenario shows mixed endings round-tripping cleanly); ArrowUp/Down recall history

## Tags & highlight

- [ ] Select text in a console (e.g. `[ERROR]`) → the tag button lights up (in that pane's controls) → click it → a colored chip appears and matching lines are colored across the full line
- [ ] The **funnel** (filter) menu: Include shows only tag-matched lines; Exclude hides them; Off restores everything (no data was lost)
- [ ] ⚙ panel: rename, edit pattern, toggle regex, recolor, delete — reflected instantly in every pane and persisted (reload the window: tags survive)
- [ ] Highlighted lines leave colored marks on the overview strip right of the scrollbar; click jumps

## Find (per pane, Ctrl+F)

- [ ] Ctrl+F or the pane's 🔍 opens the find widget: **Aa** match-case, **ab** whole word, **.*** regex (bad regex shows `Bad pattern`)
- [ ] Occurrence counter (`2 of 6` / `No results`), Enter/Shift+Enter and F3/Shift+F3 walk matches; the current match is orange, others yellow; text selection still works over highlights
- [ ] Find ticks (orange, second overview strip) show where matches sit; clicking one jumps to the nearest match

## Log files

- [ ] ⚪/🔴 per pane: toggling logs the session (save dialog, or the configured directory); 🔴 title shows the file; right-clicking 📁 clears the directory
- [ ] 📂 opens a saved `.log`/`.txt` as a read-only pane (📄 prefix) with find/filter working on it
- [ ] 📤 exports the pane's buffer to a file

## Scroll Lock (per pane)

- [ ] While streaming, scroll one pane up → its indicator flips to **🔒**, that viewport holds still while the other pane keeps scrolling
- [ ] Scroll back to the bottom → **⇩ Following** resumes; the button toggles manually and rejoining snaps to the bottom

## Timestamps

- [ ] **⏱** toggles `[HH:MM:SS.mmm]` prefixes in every pane at once; on by default
- [ ] Tag matching is unaffected by timestamps either way (match on the same text with timestamps on and off)

## Split-view chrome

- [ ] Drag the divider between panes to resize; double-click restores equal halves
- [ ] Each pane header shows a status dot (green monitoring / yellow connecting / gray stopped) and a close ×; closing a connected pane disconnects just that port

## Buffer & performance

- [ ] `burst --seconds 10` (~2000 lines/s): both panes stay smooth (virtualized rendering)
- [ ] After a long burst, memory stays bounded and the oldest lines are gone (buffer capped at `serialLens.maxBufferLines`, default 10,000)
- [ ] Lower `serialLens.maxBufferLines` to e.g. 500 mid-session → buffer trims immediately

## Public API (consumer view)

- [ ] Another extension (or the integration suite) can call `getSerialMonitorApi(Version.latest)` → `listAvailablePorts` → `startMonitoringPort` (several may run) → `Port.onClosed` fires on stop

## Known limits (by design, see spec Out of Scope)

- TCP/SWO unsupported (API reports it); no inline badges, ANSI interpretation, plotting, or send macros. Log export exists (📤).
