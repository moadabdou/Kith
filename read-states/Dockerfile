# Stage 1: Build Rust binary with layer caching
FROM rust:bookworm AS builder
WORKDIR /app

# Cache dependency manifests
COPY Cargo.toml ./
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
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -u 10001 -U app
USER app

COPY --from=builder /app/target/release/read-states /usr/local/bin/read-states

EXPOSE 8085
ENTRYPOINT ["read-states"]
