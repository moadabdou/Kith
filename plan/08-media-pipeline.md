# 08 — Media Pipeline (uploads, Rust workers, CDN)

> Phase 8. Attachments/profile images → storage → async processing → CDN
> delivery. Where "Rust for performance-critical parts" meets real-world
> CPU-bound work, and where you learn why CDNs exist (they're not for HTML).

## 1. The upload flow (build in this order)

```
Client → POST /files (multipart or presigned PUT)
   │  auth: ATTACH_FILES perm in target channel (06) — or profile scope
   │  size limit: 25MB default (make configurable)
   ▼
REST (Go):
   1. sniff content-type from bytes (http.DetectContentType — never trust the
      client's claim), compute sha256
   2. content-addressed path: /attachments/{channel_id}/{snowflake}/{sha256}.{ext}
      (immutable + dedupable + CDN-cache-forever-friendly: same content = same
      URL = same cache entry. Content addressing is the trick — note it.)
   3. stream to MinIO (S3 API, local) via presigned flow:
      Option A: client uploads through REST (simpler, pins REST CPU/bandwidth)
      Option B: REST returns presigned PUT URL, client uploads direct to MinIO,
        then client calls POST /files/:id/complete
      Build A first, refactor to B — feel the difference (REST as coordinator
      vs data-plane passthrough. Same lesson as gateway-vs-SFU.)
   4. INSERT file row (PG: id, owner, sha256, size, mime, status=pending)
   5. publish FILE_UPLOAD event → media worker queue
   ▼
Rust worker (§2): generates thumbnails, transcodes, extracts metadata
   → status=ready + attachment_thumbnails JSON
   ▼
Client GET https://cdn.localhost/attachments/.../{sha256}.ext
   → CDN layer (§3) → cached forever (immutable, remember?)
```

Message attachments: `POST /messages` accepts `attachment_ids[]` referencing
already-uploaded files (Discord's two-step). The MESSAGE_CREATE event carries
resolved attachment URLs (signed for the client's session — see §3 note).

## 2. The Rust media worker (the CPU-bound lesson)

One Rust binary, N worker threads (`rayon`), consuming the FILE_UPLOAD topic
(NATS JetStream — same at-least-once + idempotency discipline as the search
indexer in 04 §3: re-processing an image must be safe; content-addressed
outputs make it naturally so).

Jobs:
- **Images**: `image` crate — resize to thumbnail sizes (Discord serves
  ~80px/128px/256px/512px variants), EXIF strip (privacy lesson: GPS in
  photos is a real leak class — test it with a geotagged file), format
  normalize (keep original + generate JPEG/WebP derivatives).
- **Video**: ffmpeg subprocess (via `std::process`, or `ffmpeg-sidecar`) —
  poster frame + duration probe. (Don't hand-roll codecs; wrapping ffmpeg IS
  the industry answer. Learn the exec/sandbox dance.)
- **Metadata**: dimensions, duration, animated-flag; feed to client so it can
  reserve layout space (CLS — tiny lesson, but it's why Discord messages
  don't jump when images load).

Why Rust here (the honest engineering answer, mirrored in your postmortem):
- CPU-bound, parallel, latency-insensitive-but-throughput-sensitive — the GC
  tax argument from read-states (05 §3) applies *less* here; throughput per
  core is the metric. Measure: process 1k images with a Go worker and a Rust
  worker, compare wall-time + allocations + memory RSS. Smaller gap than
  read-states? Say so in the write-up. The skill is *predicting where Rust
  pays* — media pipelines are also where Discord uses it for a different
  reason: no GC pauses on the *transcode* path matter less, but memory
  predictability under burst matters (OOM-kill resistance at peak).
- Sandbox discipline: workers touch untrusted bytes. File-size caps, decode
  bomb guards (image crate has limits; a 40x40000 PNG is a classic decompression
  bomb — test with one), process isolation for ffmpeg, no network egress from
  workers. Write a threat-model paragraph before coding.

## 3. CDN layer (learn what a CDN actually does)

Local simulation with real CDN semantics — a caching reverse proxy in front
of MinIO:

```
Client → Caddy (cdn.yourdomain) 
   ├── cache: everything under /attachments/ — immutable →
   │   Cache-Control: public, max-age=31536000, immutable
   ├── private/* (profile banners etc.): shorter TTLs, per-object rules
   └── origin → MinIO
```

Required experiments:
1. **Cache-hit math**: 1000 users viewing the same meme once per hour =
   1000 origin hits (bad) vs N edge hits + 1 origin hit (good). Simulate with
   `hey`/`k6` against Caddy with/without cache: plot origin req/s. That gap
   *is* the CDN business case — now you can explain Cloudflare to someone.
2. **Signed/authorized media** (Discord does this): attachments in private
   channels shouldn't be public-forever URLs. Pattern: short-lived signed
   query params (`?ex=...&hm=sha256(key,path,exp)`) verified at the edge
   (Caddy can't do this natively — write a tiny Go edge handler, or accept
   the tradeoff and document it. Discord launched signed URLs in 2023-ish —
   read their announcement).
3. **Range requests**: video scrubbing depends on HTTP Range. Verify Caddy+
   MinIO serve 206s; test a 100MB file streamed from byte-offset.
4. Cache purge/invalidation: content-addressed URLs mean you never purge —
   *immutability kills invalidation*. Contrast: profile avatars are mutable →
   versioned URLs (`/avatars/{uid}/{version}.png`) instead of purges.
   Version-in-URL is the other industry trick; collect it.

## 4. Upload path hardening checklist

- [ ] Content-type sniffed server-side; extension/mime mismatch rejected
- [ ] Decompression-bomb test (huge-dimension PNG) survives without OOM
- [ ] EXIF GPS stripped (verify with exiftool before/after)
- [ ] Presigned URL expiry ≤ 15min; upload quota per user per day (Redis counter)
- [ ] Abandoned uploads GC'd (pending file rows older than 24h → delete object + row)
- [ ] Worker idempotent: kill mid-job, JetStream redelivers, re-process converges

## 5. Phase 8 gate

- [ ] End-to-end: upload image → thumbnails ready → message with attachment
      renders (with reserved dimensions) → second viewer gets cache HIT
- [ ] Rust-vs-Go worker benchmark written up (throughput, RSS, tail latency)
- [ ] CDN origin-offload graph captured (with/without cache under k6)
- [ ] Signed-URL design decision documented with tradeoffs
- [ ] Threat-model paragraph + all hardening checks green

## 6. Reading
- Discord: "Behind the Scenes: How Discord Handles Millions of File Uploads" /
  their media/CDN engineering posts (see 12-references §Phase 8)
- Cloudflare docs: "What is a CDN" + cache-control semantics (short, and now
  they'll click)
- `image` crate docs (limits), ffmpeg-sidecar README
