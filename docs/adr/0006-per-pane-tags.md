# ADR-0006: Tags and filter mode are per-pane state

Date: 2026-11-03
Status: Accepted
Supersedes the global tag vocabulary part of ADR-0003/0004 (the Tag model
itself — pattern, color, highlight/filter flags — is unchanged).

## Context

Tags started as one workspace-wide vocabulary: a single list persisted to
`serialMonitor.tags`, broadcast to every pane, with one global filter mode.
Once multi-monitor became the product (ADR-0005) that stopped matching how
people work: two devices stream different vocabularies, a tag created from
pane 1's output should not light pane 2, and a filter tuned for a noisy
device must not collapse its neighbor.

## Decision

- **A pane owns its tags.** `PaneSession.tags` is per session; chips, the
  ⚙ panel, tag-from-selection, highlighting, and find recomputes all read and
  mutate the focused pane's list. Another pane is never touched.
- **Filter mode is per pane too** — include/exclude over that pane's tags.
- **Persistence is keyed by port** (`serialLens.portTags:
  Record<path, Tag[]>`). A port's set survives close/reopen; moving a pane to
  another port starts that port's set. File panes keep session-scoped tags.
- **The webview owns mutations** through the pure core `shared/tagList.ts`
  (makeTag / patchedTag / withoutTag / sanitizeTags); the host only persists
  what the pane sends (`saveTags`). The old global `tags`/`createTag`/
  `updateTag`/`removeTag`/`clearTags` wire messages are gone; the push is
  `{type:'tags', sessionId, tags}` on session creation.
- The legacy `serialMonitor.tags` setting is no longer read or written.

## Consequences

- Two panes can highlight the same text differently — same line, different
  decisions per pane; the matching seam (`matchLine(text, tags, mode)`) was
  already pure and per-call, so nothing downstream changed shape.
- "Delete all", renames, and chip toggles in the ⚙ panel apply to the pane
  named in the panel header.
- The persistence key is the port recorded when the session is created,
  so edits persist even while the pane is stopped; only a session with no
  port at all (file panes) stays memory-only.
- The empty row has no pane: its funnel/tag/manage controls are disabled.
