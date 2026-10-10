# Margin — offline markdown reader

A single-page, no-build PWA for reading `.md` files on Android. Your file is never
modified: highlights, notes, settings and reading position live in IndexedDB, keyed by a
hash of the file, and are exportable as JSON or markdown.

## Weight

| File | Raw | Gzipped |
|---|---|---|
| `assets/app.js` | 40 KB | 12 KB |
| `assets/app.css` | 16 KB | 5 KB |
| `vendor/marked.min.js` | 39 KB | 12 KB |
| `vendor/purify.min.js` | 22 KB | 8 KB |
| `index.html` + `sw.js` + manifest | 12 KB | 4 KB |
| icons (3 PNGs) | 6 KB | — |

**134 KB** total, **41 KB** over the wire with gzip. No fonts are downloaded —
the typeface options map to faces already on the device. No runtime network calls at all.

## Deploy on Render (free)

1. Push this folder to a GitHub repo (all files at the repo root).
2. Render dashboard → **New → Static Site** → pick the repo.
3. **Build command:** leave empty. **Publish directory:** `.`
4. Create. You get `https://<name>.onrender.com`.

`render.yaml` is included if you prefer **New → Blueprint** instead. Free static sites on
Render don't sleep, and after the first load the app runs entirely from the service worker
cache, so a sleeping or offline host doesn't matter.

Custom domains and HTTPS are automatic. HTTPS is required — service workers won't
register over plain HTTP (except on `localhost`).

## Install on Android

Open the URL in Chrome → menu → **Add to Home screen** → *Install*. It launches
standalone, no address bar. Turn on airplane mode to confirm it still opens.

### Updating a deployed copy

**Bump `VERSION` in `sw.js` on every deploy.** Chrome decides whether to update a service
worker by byte-comparing that one file. If `sw.js` is unchanged, the browser never
re-installs it and keeps serving the previously cached `app.js` — your new code deploys to
Render but never reaches the phone. Bump `BUILD` in `assets/app.js` to match, so the
running build is visible on the device.

Then: redeploy → open the app → you'll see *"New version ready — reload to apply"* →
reload. Verify in **Library → Version**, which shows the build the page is running and the
build the offline cache holds. If those disagree, reload once more; if they still disagree,
the `sw.js` version wasn't bumped.

Make sure Render serves `sw.js` with `Cache-Control: no-cache`. `render.yaml` sets this; if
you created the site through the dashboard instead, add the header manually under
**Settings → Headers**, or the CDN will keep serving the old worker and nothing will ever
update.

## Getting a file in

- **Open a .md file** — the file picker, including Google Drive and Downloads.
- **Share to Margin** — from any file manager, share a `.md` file and pick Margin. This
  uses the Web Share Target API and only works after the app is installed.
- **Paste markdown** — for text you copied from elsewhere.
- **Drag and drop** — on desktop.

## What it does

**Launcher** — the app opens on a file chooser, not the last file. It shows a *Continue
reading* card plus every file you've added, each with the section you stopped in, a
progress bar, when you last opened it ("5 days ago · 20 Aug 2026") and how many times.
Tap one to resume at the exact block. Turn on *Reopen last file on launch* in settings if
you'd rather skip the chooser.

**Reading** — Paper / Sepia / Dark / Black (OLED) themes plus Auto, six typefaces, text
size, line height, line width, letter spacing, justification, and a distraction-free mode
where the top bar slides away as you read.

**Reflow zoom** — pinch with two fingers anywhere in the text. Unlike browser zoom, lines
re-wrap to the screen instead of scrolling sideways. `Ctrl` + scroll wheel does the same on
desktop.

**In-app text selection** — long-press a word, drag to extend, and Margin's own note bar
appears. Android gives no way to hide the system selection popup (Search / Web search /
Share) while native selection is on, so the reader is marked non-selectable and selection
is handled in-app: the OS sees nothing selectable and never shows its menu. Drag past the
top or bottom edge to keep extending. Switch it off in settings to get the system menu
back — it turns on automatically on touch screens and off for a mouse.

**Notes** — four highlight colours, or attach a comment. Highlighted text with a note
carries a small dot; tap it to reopen. Selections may span several paragraphs. The thin
rail down the right edge shows where every note sits — tap a tick to jump there.

**Resume** — position is stored as a block index plus a fraction, not a pixel offset, so it
survives font-size, width and theme changes. Saved continuously while scrolling and again
when you switch away from the app.

**History** — Library → *This file* lists every time you opened it, e.g. *24 August 2026 at
7:04 pm*.

**Markdown support** — GFM via `marked`: tables, task lists, strikethrough, fenced code,
autolinks, footnotes (`[^1]`), YAML front matter shown as a header block, `<details>`,
heading anchors, and lightweight syntax colouring for code. HTML in the file is sanitised
with DOMPurify before it reaches the page.

**Also** — table of contents, find-in-page, copy-code buttons, reading progress bar, word
count and reading time, export notes as markdown, back up and restore everything as JSON,
and a print stylesheet.

## Data and privacy

Nothing leaves the device. `IndexedDB` holds file text (`docs`) and annotations, position
and open history (`meta`); `localStorage` holds display settings. Clearing site data in
Chrome erases all of it — use **Back up all data** first.

## Structure

```
index.html               app shell
assets/app.css           themes and reading typography
assets/app.js            storage, rendering, annotations, position
vendor/marked.min.js     markdown parser (MIT)
vendor/purify.min.js     HTML sanitiser (Apache-2.0 / MPL-2.0)
sw.js                    offline cache + share-target handler
manifest.webmanifest     install metadata
```

## Known limits

- Images referenced by URL need a connection the first time; local image paths inside a
  `.md` won't resolve, since only the text is imported.
- Notes anchor to character offsets within a rendered block. Editing the file externally
  and re-adding it creates a new entry (different hash) with its own notes; the old one
  stays in the Library until you remove it.
- KaTeX and Mermaid are deliberately absent — either would more than double the payload.
