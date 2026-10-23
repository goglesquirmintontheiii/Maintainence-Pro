# Feedback capture (temporary)

**Added in 0.4.2. Remove by 1.9.0, or 2.0.0 at the latest.** It's checklist item MP-120 in the 2.0.0 milestone, and
`tests/test_temporary_features.py` fails once `__version__` reaches `REMOVE_BY` (1.9.0) while this folder still exists.

A testing aid for the release checklist, not a product feature. Press **Ctrl+Shift+F** anywhere in MPro:

- **Click** an element (it highlights like the browser's inspector; ↑/↓ moves to the parent/child, Enter picks), or
- **drag** over an area to screenshot it.

Then choose Bug / Feature / Change / Note and a priority, write the note, and **Create code**. The code is copied;
paste it into the checklist's **Requests → Paste a capture** box, which unpacks it into a request with the screenshot
and element details for Claude to review. Codes pasted into a chat can be unpacked with
`python scripts/decode_capture.py CODE_OR_FILE` (prints a summary, saves the JSON and the screenshot).

What a code holds: the note, kind and priority; the page (URL, route, title, main heading, open dialog, selected tabs,
viewport, theme, MPro version and your role); for an element, its selector, path, accessible name, text, attributes,
section headings, the table column and row it's in, the link or button around it, size and position, a few computed
styles and a short outerHTML; for an area, a screenshot and up to 60 labelled elements inside it (with table column and
row, and their numbered boxes in screenshot pixels; elements cut by the edge are kept, ones hidden behind a panel are
not), the panels or dialogs that hold the area, and notes about anything the screenshot can't show (embedded frames).

## Code format

`MPRO-FB2:` (0.4.3+) followed by base85 text of a deflate-raw stream of
`[4-byte big-endian JSON length][JSON, UTF-8][screenshot bytes]`. The base85 alphabet is printable ASCII without
`" & ' * < > \ _` and the backtick, so codes survive Markdown, HTML and chat boxes. Screenshots are WebP at up to 1.5×
the page's CSS pixels, quality 0.72 (JPEG on Safari), and step down to stay under 160 KB. The checklist and the decoder
script also read 0.4.2's `MPRO-FB1:` codes (base64 of gzip JSON with the screenshot as a data URL).

## Removing it

1. Delete this folder (`frontend/src/devtools/feedback/`, and `frontend/src/devtools/` if it's empty).
2. Delete the line `import "./devtools/feedback";` in `frontend/src/main.tsx`.
3. `cd frontend && npm uninstall html-to-image` (only this tool uses it).
4. Delete `tests/e2e/test_feedback_capture.py`, `tests/test_temporary_features.py`, `scripts/decode_capture.py`, the
   `capture_042` and `capture_043` screenshot runs in `scripts/screenshots.py`, and the "Temporary features" section in `CLAUDE.md`.
5. Note the removal in `progress.md` and tick MP-120. The checklist's paste box can stay or go; old requests keep their
   captures.

Nothing else imports from here, and the tool stores nothing on the server.
