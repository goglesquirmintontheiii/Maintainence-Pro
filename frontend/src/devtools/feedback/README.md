# Feedback capture (temporary)

**Added in 0.4.2. Remove by 1.9.0, or 2.0.0 at the latest.** `tests/test_temporary_features.py` fails once
`__version__` reaches `REMOVE_BY` while this folder still exists, so it can't be forgotten.

A testing aid for the release checklist, not a product feature. Press **Ctrl+Shift+F** anywhere in MPro:

- **Click** an element (it highlights like the browser's inspector; ↑/↓ moves to the parent/child, Enter picks), or
- **drag** over an area to screenshot it.

Then choose Bug / Feature / Change / Note and a priority, write the note, and **Create code**. The code
(`MPRO-FB1:` + gzip + base64 JSON) is copied; paste it into the checklist's **Requests → Paste a capture** box, which
unpacks it into a request with the screenshot and element details for Claude to review.

What a code holds: the note, kind and priority; the page (URL, route, title, main heading, open dialog, selected tabs,
viewport, theme, MPro version and your role); for an element, its selector, path, accessible name, text, attributes,
section headings, size and position, a few computed styles and a short outerHTML; for an area, a WebP screenshot and up
to 60 labelled elements inside it with their numbered boxes in screenshot pixels.

## Removing it

1. Delete this folder (`frontend/src/devtools/feedback/`, and `frontend/src/devtools/` if it's empty).
2. Delete the line `import "./devtools/feedback";` in `frontend/src/main.tsx`.
3. `cd frontend && npm uninstall html-to-image` (only this tool uses it).
4. Delete `tests/e2e/test_feedback_capture.py`, the feedback checks in `tests/test_temporary_features.py`, the
   `capture_042` screenshots in `scripts/screenshots.py`, and the "Temporary features" section in `CLAUDE.md`.
5. Note the removal in `progress.md`. The checklist's paste box can stay or go; old requests keep their captures.

Nothing else imports from here, and the tool stores nothing on the server.
