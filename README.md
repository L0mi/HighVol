# HighVol Web

HighVol Web is the browser version of the native iOS HighVol volleyball recorder. It is a static, installable Progressive Web App by **LomiSoup Studios**.

## Features

- Manual rolling-highlight, automatic timed-chunk, and full-match recording modes
- 15, 30, 45, 60, and 90-second highlight choices
- Match name and match-number organization
- Explicit front/back camera switching on phones and tablets, with available-camera cycling fallback on laptops and desktops
- Private on-device clip library using IndexedDB
- Best-highlight marking, clip titles, trim points, social crop previews, downloads, and supported-browser edited exports
- Responsive layouts for compact phones, modern phones, iPad/tablets, laptops, and desktop screens in portrait or landscape
- Offline app shell and Home Screen installation

## Run locally

Camera APIs require a secure context. `localhost` is treated as secure by browsers:

```bash
cd HighVol-Web
python3 -m http.server 4173
```

Then open `http://localhost:4173` in Safari, Chrome, or Edge.

## Publish

Upload the contents of this folder to any HTTPS static host, including GitHub Pages, Netlify, Vercel, or Cloudflare Pages. No server or database configuration is needed.

For GitHub Pages, make `HighVol-Web` the published site root (or copy these files to the repository root/docs folder), then enable Pages in the repository settings.

## Browser notes

- HTTPS is required after publishing.
- Camera format, resolution, and frame rate are ultimately chosen by the browser and device.
- Recordings remain in the browser where they were created. Clearing site data removes them, so download important highlights.
- Edited copy export uses real-time Canvas recording where supported. If unavailable, HighVol keeps the original downloadable clip.
- iPhone and iPad users should use Safari for the best camera and Home Screen experience.
