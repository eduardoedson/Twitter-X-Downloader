# Twitter/X Downloader

A Chrome extension that adds a download button to tweet action bars, letting you save photos, GIFs, and videos from X/Twitter in one click.

## Features

- One-click download for tweet media (single or multiple items)
- Highest-bitrate MP4 chosen for videos and animated GIFs
- Photos saved using original-quality URLs (`name=orig`)
- Integrated button with loading, success, and error states
- Works on `x.com` and `twitter.com`

## How it works

1. `src/content/inject.ts` runs in `world: MAIN` and captures GraphQL responses from X.
2. `src/modules/twitter/parser.ts` extracts media entries from tweet payloads.
3. `src/modules/twitter/content.ts` injects the download button into each tweet action bar.
4. `src/background/index.ts` receives download requests and saves files through `chrome.downloads`.

## Install (developer mode)

Requirements: Node.js 18+ and npm.

```bash
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select `dist/`
4. Open `x.com` or `twitter.com` and click the download button on a tweet with media

## Development

```bash
npm run dev
npm run typecheck
npm run build
```

## Project structure

```
src/
├── manifest.json
├── background/index.ts
├── content/
│   ├── inject.ts
│   ├── index.ts
│   └── content.css
├── modules/
│   ├── shared/
│   │   ├── download.ts
│   │   ├── filename.ts
│   │   └── ui.ts
│   └── twitter/
│       ├── constants.ts
│       ├── content.ts
│       └── parser.ts
└── popup/
```

