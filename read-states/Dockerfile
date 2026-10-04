# Stage 1: Build Rust binary with layer caching
FROM rust:bookworm AS builder
WORKDIR /app

# Proxy for restricted networks (mirrors gateway/api build args).
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY="localhost,127.0.0.1"
ENV http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY
ENV no_proxy=$NO_PROXY NO_PROXY=$NO_PROXY

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

ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
# apt does not honor env proxy vars; wire it explicitly when provided.
RUN if [ -n "$HTTP_PROXY" ]; then echo "Acquire::http::Proxy \"$HTTP_PROXY\";" > /etc/apt/apt.conf.d/99proxy; fi && \
    if [ -n "$HTTPS_PROXY" ]; then echo "Acquire::https::Proxy \"$HTTPS_PROXY\";" >> /etc/apt/apt.conf.d/99proxy; fi && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99proxy

RUN useradd -u 10001 -U app
USER app

COPY --from=builder /app/target/release/read-states /usr/local/bin/read-states

EXPOSE 8085
ENTRYPOINT ["read-states"]
