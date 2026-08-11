# Short-video resolver service boundary

The Tesla client must always call the same-site gateway:

```text
GET  /api/short-video/resolve
POST /api/short-video/resolve
```

The browser never receives the resolver token and never calls the external
resolver directly. No navigation item is enabled until a resolver is
configured.

## Server-only environment variables

```env
SHORT_VIDEO_RESOLVER_BASE_URL=https://resolver.example.com/
SHORT_VIDEO_RESOLVER_TOKEN=replace-with-a-long-random-secret
SHORT_VIDEO_RESOLVER_TIMEOUT_MS=12000
```

All variables are server-only. Do not add the `NEXT_PUBLIC_` prefix. Production
resolver URLs must use HTTPS; plain HTTP is accepted only for localhost
development.

- `GET /api/short-video/resolve` reports whether the adapter is configured.
- `POST /api/short-video/resolve` accepts `{"url":"https://v.douyin.com/.../"}`.
- Both routes require the existing MoonTV login.
- Only official Douyin HTTPS hosts are accepted.
- If the server is not configured, POST returns HTTP 503 with
  `RESOLVER_NOT_CONFIGURED`.

## External resolver contract v1

MoonTV calls `POST {SHORT_VIDEO_RESOLVER_BASE_URL}/v1/resolve` with:

```json
{
  "version": "1",
  "provider": "douyin",
  "url": "https://v.douyin.com/example/",
  "playback": {
    "preferredContainers": ["hls", "mp4"],
    "preferredVideoCodec": "h264",
    "preferredAudioCodec": "aac"
  }
}
```

The resolver authenticates the request with
`Authorization: Bearer <SHORT_VIDEO_RESOLVER_TOKEN>` and returns:

```json
{
  "version": "1",
  "provider": "douyin",
  "id": "video-id",
  "title": "title",
  "author": "author",
  "cover": "https://cdn.example.com/cover.jpg",
  "duration": 32.5,
  "media": [
    {
      "url": "https://cdn.example.com/video.m3u8",
      "container": "hls",
      "videoCodec": "h264",
      "audioCodec": "aac",
      "width": 1080,
      "height": 1920,
      "bitrate": 1800000,
      "expiresAt": "2026-08-11T12:00:00.000Z"
    }
  ]
}
```

The gateway rejects malformed responses and media that is not HTTPS,
H.264/AAC, HLS, or MP4. This keeps the future short-video page aligned with the
Tesla Canvas/WebCodecs player instead of silently falling back to native video.

## Migration path

The website can remain on Vercel while only the resolver runs on a custom
server. Later, the full Next.js application can move to that server without
changing browser calls or the resolver contract: copy the same environment
variables and keep the relative `/api/short-video/resolve` URL.
