# Short video resolver contract

The browser only talks to same-origin MoonTVPlus routes. A private resolver is configured with server-only environment variables:

- `SHORT_VIDEO_RESOLVER_BASE_URL`
- `SHORT_VIDEO_RESOLVER_TOKEN`
- `SHORT_VIDEO_RESOLVER_TIMEOUT_MS` (optional)

The application calls `${SHORT_VIDEO_RESOLVER_BASE_URL}/v1/resolve` for an individual public Douyin link and `${SHORT_VIDEO_RESOLVER_BASE_URL}/v1/feed` for the recommendation feed. Both requests use contract version `1` and a Bearer token.

## Recommendation feed

`POST /v1/feed` receives:

```json
{
  "version": "1",
  "provider": "douyin",
  "mode": "recommend",
  "cursor": "opaque-cursor",
  "limit": 8,
  "playback": {
    "preferredContainers": ["hls"],
    "preferredVideoCodec": "h264",
    "preferredAudioCodec": "aac",
    "preferredSegmentFormat": "mpegts"
  }
}
```

The cursor is opaque. The resolver owns visitor-session maintenance, recommendation pagination, duplicate filtering, rate limiting and refresh of expired platform URLs. The browser must never receive platform cookies or signing tokens.

The response contains complete video items:

```json
{
  "version": "1",
  "provider": "douyin",
  "items": [
    {
      "version": "1",
      "provider": "douyin",
      "id": "video-id",
      "title": "title",
      "description": "description",
      "author": "author",
      "cover": "https://...",
      "duration": 42.5,
      "media": [
        {
          "url": "https://resolver.example/v1/media/video-id/master.m3u8",
          "container": "hls",
          "segmentFormat": "mpegts",
          "videoCodec": "h264",
          "audioCodec": "aac",
          "width": 720,
          "height": 1280
        }
      ]
    }
  ],
  "nextCursor": "opaque-next-cursor",
  "hasMore": true
}
```

## Tesla media requirement

Douyin commonly returns separate DASH video and audio tracks and may automatically select HEVC in a desktop browser. The resolver must explicitly choose AVC1/H.264 video plus MP4A/AAC audio, then remux (not transcode) them into MPEG-TS HLS for the existing Tesla Canvas/WebCodecs pipeline. Remuxing should start lazily when the selected HLS URL is requested; generating every feed item's HLS stream in advance wastes bandwidth and CPU.

Feed items with MP4, fMP4 HLS, HEVC, AV1, missing audio or non-HTTPS media are rejected by the same-origin gateway. No native-video fallback is exposed on the short-video page.

## Browser routes

- `GET /api/short-video/resolve`: authenticated resolver status
- `POST /api/short-video/resolve`: authenticated single-link resolution
- `GET /api/short-video/feed?cursor=...&limit=8`: authenticated recommendation pagination

When the resolver is not configured, the `/short-video` entry stays visible and shows a clear setup state instead of a fake feed or a hard-coded list of sample links.
