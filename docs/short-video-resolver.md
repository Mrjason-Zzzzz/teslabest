# Short video resolver contract

The browser only calls authenticated, same-origin MoonTVPlus routes. With no extra environment variables, the Vercel Node route obtains an anonymous Douyin recommendation feed and returns only combined H.264/AAC MP4 URLs. The browser never receives platform cookies or signing secrets.

## Default Vercel-direct mode

- `GET /api/short-video/resolve`: returns `{ mode: "vercel-direct", output: "mp4-h264-aac" }`.
- `GET /api/short-video/feed?cursor=...&limit=8`: obtains a fresh recommendation page, filters out entries without a combined H.264/AAC MP4, and returns an opaque next cursor.
- `POST /api/short-video/resolve`: resolves an individual public Douyin share URL through the public share page data.
- Responses use `private, no-store`; media URLs are treated as expiring and are never persisted.

The same-origin gateway validates source hosts, redirect hosts, response size, request timeout and HTTPS media URLs. Feed failure is reported explicitly; it does not substitute hard-coded sample links.

## Tesla media path

The short-video page accepts only:

- combined MP4 with H.264 video and AAC audio; or
- MPEG-TS HLS with H.264 video and AAC audio from a future external resolver.

MP4 is progressively parsed in the browser with MP4Box.js. Encoded H.264/AAC samples then enter the existing `VideoDecoder` / `AudioDecoder`, Canvas and WebAudio path. There is no native-video fallback on the short-video page.

## Future external resolver migration

The existing migration port remains available. Set these server-only variables to switch both resolve and feed calls to a private resolver without changing the page contract:

- `SHORT_VIDEO_RESOLVER_BASE_URL`
- `SHORT_VIDEO_RESOLVER_TOKEN`
- `SHORT_VIDEO_RESOLVER_TIMEOUT_MS` (optional)

`POST /v1/feed` receives contract version `1`, an opaque cursor, the page limit and this playback preference:

```json
{
  "preferredContainers": ["mp4", "hls"],
  "preferredVideoCodec": "h264",
  "preferredAudioCodec": "aac",
  "preferredSegmentFormat": "mpegts"
}
```

The private resolver may return combined H.264/AAC MP4 directly or remux separate AVC1/MP4A tracks into H.264/AAC MPEG-TS HLS. HEVC, AV1, silent video, fMP4 HLS and non-HTTPS media remain rejected.
