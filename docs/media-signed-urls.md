# Media Architecture: Signed URLs & Edge Delivery

> **Context**: Phase 8 (`plan/08-media-pipeline.md §3`, Issue #101).  
> Documents the architectural design decisions, Discord 2023 signed URLs rollout comparison, and edge verification trade-offs.

---

## 1. The Threat Model: Why Signed URLs?

Before late 2023, Discord attachments in private channels and direct messages were served via permanent, public CDN URLs. If an attacker or malicious user obtained the direct CDN link (`https://cdn.discordapp.com/attachments/...`), they could:
1. **Bypass Access Control Forever**: Share private files and sensitive screenshots externally to users outside the guild or DM.
2. **Abuse CDN Infrastructure (Hotlinking)**: Use Discord's CDN as free, unlimited file hosting for third-party websites, piracy networks, and malware distribution.
3. **Prevent Revocation**: Even if a message was deleted or the user was banned, the CDN cached the file under its immutable content-addressed key indefinitely.

### Discord's 2023 Solution
In late 2023, Discord announced and rolled out time-limited HMAC-signed URLs for all attachment assets:
- **`ex`**: Hex-encoded UNIX expiration timestamp (e.g. 24 hours).
- **`is`**: Hex-encoded UNIX issuance timestamp.
- **`hm`**: HMAC-SHA256 hex digest calculated over `path + ex + is` using a cluster-wide secret key.

Clients must refresh expired attachment URLs by re-fetching the message or requesting fresh signed links from the REST API.

---

## 2. Kith Implementation Architecture

In Kith, attachment delivery is split between **Caddy (the edge reverse proxy / CDN)**, **Go API (the edge auth & media coordinator)**, and **MinIO (the S3-compatible origin)**.

```
                      ┌────────────────────────────────────────┐
                      │          Client / Video Player         │
                      └──────────────────┬─────────────────────┘
                                         │
                         GET cdn.localhost/attachments/...
                                         │
                                         ▼
                      ┌────────────────────────────────────────┐
                      │              Caddy Edge                │
                      │  - Injects immutable Cache-Control     │
                      │  - Preserves HTTP Range byte-headers   │
                      │  - Reverse proxies to Go Edge Handler  │
                      └──────────────────┬─────────────────────┘
                                         │
                                         ▼
                      ┌────────────────────────────────────────┐
                      │           Go API Edge Handler          │
                      │   (/attachments/{cid}/{aid}/{file})    │
                      ├────────────────────────────────────────┤
                      │ 1. Checks ?hm= signature               │
                      │    - Invalid or expired? → HTTP 403    │
                      │    - Unsigned private channel? → 403   │
                      │ 2. Streams object from MinIO           │
                      │    - Range header? → HTTP 206          │
                      └──────────────────┬─────────────────────┘
                                         │
                                         ▼
                      ┌────────────────────────────────────────┐
                      │              MinIO Origin              │
                      │   Bucket: 'attachments'                │
                      └────────────────────────────────────────┘
```

### URL Signing Format
```text
/attachments/{channel_id}/{attachment_id}/{filename}?ex=68db...&is=68da...&hm=a1b2c3...
```
- **Secret Management**: Signed using the cluster's `JWT_SECRET` (or dedicated `MEDIA_SIGNING_KEY`).
- **Private Channel Awareness**:
  - Direct Messages (`guild_id == nil`) are private by definition.
  - Guild channels check `channel_overwrites` for `@everyone` `VIEW_CHANNEL` denial.
  - When messages are retrieved (`GET /channels/{id}/messages`) or posted (`POST /messages`), attachments and thumbnail tiers in private channels are automatically HMAC-signed with a 24-hour TTL.

---

## 3. Edge Verification Trade-Offs

| Approach | Latency | Verification Security | Cache Efficiency | Operational Complexity |
| :--- | :--- | :--- | :--- | :--- |
| **Direct MinIO Proxy (No Signature)** | Lowest (~1ms) | ❌ None (public access to all files) | High (cache key = path) | Lowest |
| **Caddy Native Wasm/Lua Plugin** | Very Low (~2ms) | ✅ Edge verification | Medium (requires custom build) | High (custom Caddy compilation) |
| **Go Edge Media Handler (Kith Choice)** | Low (~3-5ms) | ✅ Full HMAC + Channel Perms | High (immutable Cache-Control) | Minimal (uses existing Go stack) |
| **Cloudflare Workers / Fastly VCL** | Low (~3ms) | ✅ Distributed edge validation | Optimized per-POP caching | Requires commercial edge CDN |

### Key Trade-Off Decisions:
1. **Stateless HMAC vs. Database Check at Edge**:
   - Verification only requires validating the HMAC digest and comparing `ex` against `time.Now()`.
   - No database queries or Redis lookups are performed for signed public/private asset requests, keeping edge CPU cost at $O(1)$ and protecting Postgres from read spikes during video streaming.
2. **Cache Key Interaction with Expiry (`ex`)**:
   - Because query parameters change every 24 hours when URLs are refreshed, caching simply by `URL` would cause cache misses across link refreshes.
   - **Resolution**: Content-addressed storage paths (`/attachments/{channel_id}/{attachment_id}/{sha256}.{ext}`) are inherently immutable. CDNs can strip or ignore query strings when evaluating cache hits *after* signature verification succeeds at the edge.
3. **HTTP 206 Partial Content (Byte Range Requests)**:
   - Video scrub operations issue `Range: bytes=X-Y` requests.
   - Go's `http.ServeContent` natively maps HTTP byte ranges onto MinIO's `io.ReadSeeker`, returning `HTTP/1.1 206 Partial Content` with `Content-Range: bytes X-Y/Total` and `Accept-Ranges: bytes`.
