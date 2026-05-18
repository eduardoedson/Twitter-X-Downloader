# Twitter/X Downloader

A Chrome extension that adds a download button to every tweet's action bar, letting you save any media — photos, GIFs, and videos — with a single click.

## Features

- **One-click download** of all media in a tweet (handles multi-photo tweets)
- **Videos**: picks the highest-bitrate MP4 variant available
- **Photos**: downloaded at **original resolution** (not the compressed feed version)
- **GIFs**: saved as MP4 (the actual format X serves)
- Button visually integrated into the native X action bar
- Visual states: green (ready) → loading → purple (downloaded) | red + alert (error)
- Works on both `x.com` and `twitter.com`

## Stack

- **Manifest V3** with a `world: MAIN` content script for GraphQL interception
- **TypeScript** with `strict`
- **Vite 5** + `@crxjs/vite-plugin` (HMR for content scripts + manifest bundling)
- No UI framework — plain DOM for the button and popup

## How it works

1. The **inject script** (`src/content/inject.ts`) runs in the main world at `document_start` and patches `window.fetch` + `XMLHttpRequest` to clone responses from X's GraphQL endpoints (`TweetResultByRestId`, `TweetDetail`, `HomeTimeline`, etc.).
2. Responses are forwarded via `postMessage` to the **isolated content script** (`src/content/index.ts`).
3. A **parser** (`src/lib/tweet-parser.ts`) walks the JSON tree looking for `legacy.extended_entities.media[]` and caches `tweetId → media[]`.
4. A **MutationObserver** detects `article[data-testid="tweet"]` nodes, identifies tweets with media, and injects the download button into the `[role="group"]` action bar.
5. Button click → `chrome.runtime.sendMessage` to the **service worker** (`src/background/index.ts`) → `chrome.downloads.download()` with filename `{username}-{tweetId}[-{n}].{ext}`.

## Install (developer mode)

Requirements: Node.js 18+ and npm.

```bash
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and pick the `dist/` folder
4. Open `x.com`, find a tweet with media, and click the green download icon at the end of the action bar

## Development

```bash
npm run dev        # Vite in watch mode with HMR
npm run build      # production bundle into dist/
npm run typecheck  # TypeScript only, no bundler
```

While `npm run dev` is running, edits to:
- `src/content/index.ts`, `src/content/content.css`, `src/lib/*` → HMR auto-reloads the X tab
- `src/content/inject.ts` (main world), `src/background/index.ts`, `src/manifest.json` → reload manually in `chrome://extensions` (↻ button)

### Debugging

| What | How to open DevTools |
|---|---|
| Content script + inject | F12 on the x.com tab |
| Service worker (downloads) | `chrome://extensions` → click the "service worker" link on the card |
| Popup | Right-click the extension icon → "Inspect popup" |

## Project structure

```
src/
├── manifest.json              MV3 manifest (Vite + CRXJS)
├── background/index.ts        Service worker: chrome.downloads
├── content/
│   ├── inject.ts              MAIN world: patches fetch/XHR
│   ├── index.ts               Isolated world: injects button + click handler
│   └── content.css            Button styles
├── lib/
│   └── tweet-parser.ts        Walks the GraphQL JSON → media
└── popup/                     Minimal popup
public/icons/                  16/32/48/128 PNG extension icons
```

## Known limitations

- **HLS-only videos** (live streams, some long-form videos) have no MP4 variant and the button enters the error state. A `ffmpeg.wasm` fallback to mux segments is a possible next step.
- **Clicking too fast**: if the tweet's GraphQL response hasn't reached the cache yet (lazy-loaded timeline), the button waits up to 4 seconds. If it still misses, opening the tweet on its own page forces a `TweetDetail` call.
- **X's GraphQL schema changes without notice**. If the parser stops working, inspect the shape of `legacy.extended_entities.media` in a current response.
- No official Firefox support (would require manifest adjustments).

## Permissions

| Permission | Purpose |
|---|---|
| `downloads` | Save files via `chrome.downloads` |
| `storage` | Reserved for preferences (not used yet) |
| host `x.com`, `twitter.com` | Run content scripts |
| host `video.twimg.com`, `pbs.twimg.com` | X media CDNs (videos and images) |

## Legal notice

This extension is intended for **personal use**. Downloading and redistributing third-party content may violate X's Terms of Service and/or the original creators' copyright. Use responsibly.
