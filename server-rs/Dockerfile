# Multi-stage build for the Rust backend. Build from the repo root:
#   podman build -f server-rs/Dockerfile -t bird-ticker-rs .
# Replaces the Node image on Azure App Service (Linux custom container).
# No DB needed at build time (queries are runtime-checked; migrations + species
# facts are embedded into the binary).

# Pin to bookworm so the build-time OpenSSL/libcurl matches the bookworm-slim
# runtime (a trixie build links OPENSSL_3.2.0+ which bookworm lacks).
FROM rust:1-slim-bookworm AS build
WORKDIR /build
# Build deps: openssl + libcurl for the web-push (isahc) client.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY server-rs/Cargo.toml server-rs/Cargo.lock ./
COPY server-rs/src ./src
COPY server-rs/migrations ./migrations
COPY server-rs/data ./data
RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 libcurl4 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/target/release/bird-app /usr/local/bin/bird-app
COPY public ./public
ENV PUBLIC_DIR=/app/public
ENV PORT=3000
EXPOSE 3000
CMD ["bird-app"]
