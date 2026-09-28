FROM rust:1.85-bookworm
RUN useradd -u 10001 -U app
USER app
COPY target/release/media-worker /usr/local/bin/media-worker
ENTRYPOINT ["media-worker"]
