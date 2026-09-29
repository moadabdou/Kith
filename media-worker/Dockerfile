# Stage 1: Build the Rust binary with layer caching for dependencies
FROM rust:1.85-bookworm AS builder
WORKDIR /app

# Cache dependency manifests
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && \
    cargo build --release && \
    rm -rf src

# Copy real source code and build release binary
COPY src ./src
RUN touch src/main.rs && cargo build --release

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -U app
USER app

COPY --from=builder /app/target/release/media-worker /usr/local/bin/media-worker

ENTRYPOINT ["media-worker"]
