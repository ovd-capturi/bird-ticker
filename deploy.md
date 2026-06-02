# Bird Ticker Deployment Guide

## Overview
Bird Ticker is a PWA that scrapes bird observations from Netfugl and DOFbasen
and pushes alerts when missing species are spotted. The backend is the Rust
service in `server-rs/` (the former Node `proxy/` app has been retired).

## Deployment Target
- **Platform**: Azure App Service (Linux **custom container**)
- **App Name**: `bird-ticker-dk`
- **URL**: https://bird-ticker-dk.azurewebsites.net
- **Resource Group**: `bird-ticker-rg`
- **App Service Plan**: `ole_asp_7568`
- **Container Registry**: `birdtickeracr.azurecr.io`
- **Image**: `birdtickeracr.azurecr.io/bird-ticker-rs:<tag>`

## Prerequisites
- Azure CLI, authenticated (`az account show`)
- Access to resource group `bird-ticker-rg` and registry `birdtickeracr`
- For local builds: Rust toolchain, or Podman

## Build the image

Builds run server-side on ACR (its agents are x86_64; cross-building amd64
locally on Apple Silicon segfaults `rustc` under QEMU). Build context is the
repo root; `.dockerignore` keeps `node_modules`, `server-rs/target`, and `.git`
out of the upload.

```bash
az acr build \
  --registry birdtickeracr \
  --image bird-ticker-rs:v3 \
  --file server-rs/Dockerfile .
```

### Docker Hub rate limits
ACR's build agents pull the base images (`rust`, `debian`) from Docker Hub
anonymously and can hit the `TOOMANYREQUESTS` pull limit. The Dockerfile's base
images are parameterised (`RUST_IMAGE`, `RUNTIME_IMAGE`) so you can host copies
in ACR and build without touching Docker Hub:

```bash
# One-time: seed the bases into ACR. `az acr import` shares the same throttled
# egress, so if it returns 429, push from a local machine instead:
for img in rust:1-slim-bookworm debian:bookworm-slim; do
  podman pull --platform linux/amd64 docker.io/library/$img
  podman tag docker.io/library/$img birdtickeracr.azurecr.io/$img
  podman push birdtickeracr.azurecr.io/$img
done

az acr build --registry birdtickeracr --image bird-ticker-rs:v3 \
  --file server-rs/Dockerfile \
  --build-arg RUST_IMAGE=birdtickeracr.azurecr.io/rust:1-slim-bookworm \
  --build-arg RUNTIME_IMAGE=birdtickeracr.azurecr.io/debian:bookworm-slim .
```

## Deploy a new image
Point the app at the new tag and restart:

```bash
az webapp config container set \
  --resource-group bird-ticker-rg --name bird-ticker-dk \
  --container-image-name birdtickeracr.azurecr.io/bird-ticker-rs:v3 \
  --container-registry-url https://birdtickeracr.azurecr.io
az webapp restart --resource-group bird-ticker-rg --name bird-ticker-dk
```

## App settings
Required environment variables (set via `az webapp config appsettings set`):

```
WEBSITES_PORT=3000                 # container listens on 3000
DATABASE_URL=postgresql://birdapp:<pw>@bird-ticker-pg.postgres.database.azure.com:5432/birdapp?sslmode=require
DOCKER_REGISTRY_SERVER_URL=https://birdtickeracr.azurecr.io
DOCKER_REGISTRY_SERVER_USERNAME=<acr-user>
DOCKER_REGISTRY_SERVER_PASSWORD=<acr-pass>
AZURE_FOUNDRY_ENDPOINT=...
AZURE_FOUNDRY_KEY=...
AZURE_FOUNDRY_DEPLOYMENT=...
BACKFILL_DISABLED=true             # optional; skip the historical seeder
# VAPID_PUBLIC / VAPID_PRIVATE are optional — the binary ships dev defaults.
```

Keep secrets in Key Vault or app settings; never commit them.

## Database (Postgres)
Azure Database for PostgreSQL Flexible Server `bird-ticker-pg` (westeurope,
same region as the App Service). The Rust app applies migrations from the
binary-embedded `server-rs/migrations/*.sql` on boot. See git history for the
original provisioning commands.

## Verify
```bash
curl -I https://bird-ticker-dk.azurewebsites.net/healthz
curl "https://bird-ticker-dk.azurewebsites.net/api/observations"
az webapp log tail --resource-group bird-ticker-rg --name bird-ticker-dk
```

## Local development
```bash
podman compose up -d                       # Postgres + pgvector on :5432
cd server-rs
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/birdapp cargo run
```
