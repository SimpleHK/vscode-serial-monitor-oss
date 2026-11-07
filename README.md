# Serial Lens

[![CI](https://github.com/SimpleHK/serial-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/SimpleHK/serial-lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.6.0-blue.svg)](CHANGELOG.md)

**Serial streams you can actually read.** Tag any pattern and every matching
line lights up in its color; collapse ten thousand lines of noise to the ten
that matter with a display-layer filter; and search any pane with the same
find widget your editor has. An independent, MIT-licensed serial monitor for
VS Code — built around the features no other serial monitor has.

![Tags: a tag lands mid-stream, matching lines light up, and include-filter collapses the view to just the matches](docs/media/demo-tags.gif)

## Why this one

- **Tag highlighting.** Select text or type a pattern, tag it, and every
  matching line is highlighted across the full line with that tag's color —
  several tags stack, and matches are pinned on the overview strip beside
  the scrollbar (click to jump). No other serial monitor highlights
  per-line.
- **A filter that hides nothing.** Include or exclude tag matches as a
  display-layer view. Every line stays in the buffer; switching the filter
  back restores the full stream for as long as it's in the ring buffer.
- **Search that feels like your editor.** Ctrl+F in any pane: match case,
  whole word, regex, occurrence counter, F3 navigation — highlights don't
  break text selection.
- **Open and honest.** MIT-licensed, from-scratch, architecture decisions
  and a domain glossary checked in; no telemetry, no closed blobs.

## Features

### Tags: highlight and filter

Select text → tag it. Every matching line is highlighted across the full
line with that tag's color (multiple tags stack), marked on the overview
strip beside the scrollbar, and can drive the include/exclude filter. Chips
toggle highlight and filter independently per tag; the funnel menu switches
the filter mode. Nothing is discarded — switching the filter back recovers
every line still in the buffer. The demo at the top shows the whole arc: a
tag lands mid-stream, matches light up, and include-mode collapses the view
to just them.

### Display-layer filter

![Funnel filter: include collapses the view to matching lines, off restores](docs/media/demo-filter.gif)

Three states — off / include / exclude — over tag matches. Toggling is
instant and reversible for as long as lines stay in the capped ring buffer
(10,000 lines by default).

### Find per pane

![Find widget: regex mode, live counter, and highlighted matches](docs/media/demo-find.gif)

Ctrl+F opens an editor-style find widget with **Aa** match-case, **ab**
whole-word, and **.*** regex toggles, a live occurrence counter, and F3 /
Shift+F3 navigation. Matches are highlighted in place and pinned on the
overview strip; clicking the strip jumps to the nearest match.

### Several ports, side by side

![Split view: two ports streaming side by side](docs/media/demo-split-view.gif)

Open COM10 and COM12 simultaneously — each pane keeps its own buffer,
serial settings, log file, and scroll position while the other keeps
streaming. Every pane is a full monitor: its own serial config (port, baud,
data bits, parity, stop bits, line ending), start/stop, clear, log-to-file,
export, follow/lock, find, and a send bar with arrow-key history. Change
baud **while connected** and the port reopens live, keeping the pane, its
buffer, and its log file.

### The rest of a real monitor

- Per-line receive timestamps (on by default), send bar with line-ending
  choice and arrow-key history
- Per-session log-to-file (one timestamped `.log` per connection) and
  one-shot export
- Open a saved `.log`/`.txt` as a read-only pane — find, filter, and export
  work on recorded data
- Follow/Lock scrolling per pane; overview marks for highlights and find
  hits; draggable split
- Baud quick-pick with recently-used list; 300 baud → 2 Mbaud; live serial
  parameter reconfiguration

## Quick start

```bash
git clone https://github.com/SimpleHK/serial-lens.git
cd serial-lens
npm install && npm run package
```

Install the generated `.vsix` (`Extensions: Install from VSIX…`) or press
**F5** to run it from source. The monitor appears in the bottom panel as
**SERIAL LENS**.

No hardware? A com0com virtual pair works: `npm run smoke:check`, then feed
it with `npm run smoke:device -- --scenario lines`.

> [!NOTE]
> Working with real hardware is at your own risk — double-check baud rates
> and voltage levels before connecting anything you care about.

## Public API

Other extensions can drive it through the vendored
`@microsoft/vscode-serial-monitor-api` surface: `getSerialMonitorApi`,
`listAvailablePorts`, `startMonitoringPort` (multiple sessions), `Port.onClosed`,
version negotiation. TCP monitoring reports unsupported.

## Testing & architecture

```bash
npm test                # 182 unit tests (pure seams + webview DOM via happy-dom)
npm run test:integration   # 10 tests on a real VS Code host + com0com pair
npm run preview:webview # drive the real webview UI in a plain browser
node scripts/capture-frames.mjs .frames   # re-record the README GIF frames
node scripts/make-gif.mjs .frames/tags docs/media/demo-tags.gif 110 1
```

- [GLOSSARY.md](GLOSSARY.md) — domain vocabulary (Session/Pane, Tag,
  Highlight, Filter, Find, Scroll Lock, Follow); use these terms in issues
  and code
- [docs/adr/](docs/adr/) — architecture decisions (build-from-scratch, API
  alignment, unified Tag model, display-layer filter + ring buffer, one
  session per pane)
- [CHANGELOG.md](CHANGELOG.md) — what shipped in each version
- [docs/smoke-checklist.md](docs/smoke-checklist.md) — manual verification pass
- Test seams: data (chunks → lines → buffer), matching (lines + tags + filter
  mode → visibility/highlight), UI state (scroll events → Follow/locked)

## License & notices

[MIT](LICENSE). Third-party code (the vendored API surface and the bundled
`serialport` stack) is MIT-licensed; its copyright and license notices ship
inside the extension, see `node_modules/**/LICENSE` in the VSIX.

Serial Lens is an independent project — it is not affiliated with,
endorsed by, or derived from Microsoft Corporation's products. "Visual Studio
Code" and "VS Code" are trademarks of Microsoft Corporation. No telemetry,
no data collection.
