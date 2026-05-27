# Bird Ticker Deployment Guide

## Overview
Bird Ticker is a web application that fetches bird observation data from Netfugl and DOFbasen APIs, displaying alerts when missing species are spotted.

## Deployment Target
- **Platform**: Azure App Service (Linux, Node.js)
- **App Name**: bird-ticker-dk
- **Resource Group**: bird-ticker-rg
- **App Service Plan**: ole_asp_7568
- **Domain**: https://bird-ticker-dk.azurewebsites.net
- **Node Version**: 20.20.0 (configurable)

## Prerequisites
- Node.js >= v20
- Azure CLI installed
- Azure subscription with access to resource group `bird-ticker-rg`

## Deployment Steps

### 1. Local Testing
```bash
# Start local server
PORT=3000 node proxy/server.js

# Test endpoints
curl http://localhost:3000/api/ticklist?userId=5653&listType=1
curl http://localhost:3000/api/observations
curl http://localhost:3000/api/push/vapid-key
```

For a local Postgres with pgvector, use the bundled `docker-compose.yml`:
```bash
podman compose up -d
```
The local image ships pgvector but not `azure_ai`; the app detects this and falls back to a Node-side embedding helper, so no code changes are needed.

### 2. Build Deployment Package
```bash
cd /Users/ole/private/bird-app

# Create zip with app files and dependencies
zip -r bird-ticker-deploy.zip \
  proxy/ \
  public/ \
  package.json \
  .azure/config \
  node_modules/ \
  --exclude="node_modules/.cache/*" \
  --exclude="**/README*"
```

### 3. Deploy to Azure
```bash
# Method 1: Zip deploy
az webapp deployment source config-zip \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk \
  --src bird-ticker-deploy.zip

# Method 2: Direct deploy (recommended)
az webapp deploy \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk \
  --src-path bird-ticker-deploy.zip \
  --type zip
```

### 4. Verify Deployment
```bash
# Check app status
az webapp show \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk

# Check logs
az webapp log tail \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk

# Test deployment
curl -I https://bird-ticker-dk.azurewebsites.net/
curl https://bird-ticker-dk.azurewebsites.net/api/ticklist?userId=5653&listType=1
```

## Database (Postgres + pgvector)

Azure Database for PostgreSQL Flexible Server hosts the app's relational data and vector embeddings. The server lives in the same region as the App Service to keep latency low and egress free.

### 1. Provision the Server
Generate a strong admin password first and store it in Azure Key Vault or as an App Service setting; do not commit it. Then:

```bash
az postgres flexible-server create \
  --resource-group bird-ticker-rg \
  --name bird-ticker-pg \
  --location westeurope \
  --tier Burstable \
  --sku-name Standard_B1ms \
  --storage-size 32 \
  --version 16 \
  --admin-user birdapp \
  --admin-password "<generate>" \
  --public-access 0.0.0.0 \
  --database-name birdapp
```

Notes:
- `--public-access 0.0.0.0` enables the "Allow Azure services" firewall entry; explicit client IPs are added as separate rules below.
- Keep the generated password in Key Vault or in `az webapp config appsettings` (see step 5). Avoid plain-text storage.

### 2. Enable Required Extensions
`vector` and `azure_ai` must be allow-listed via the `azure.extensions` server parameter before `CREATE EXTENSION` will succeed:

```bash
az postgres flexible-server parameter set \
  --resource-group bird-ticker-rg \
  --server-name bird-ticker-pg \
  --name azure.extensions \
  --value vector,azure_ai
```

### 3. Configure azure_ai for Azure OpenAI / Foundry
These parameters let `azure_openai.create_embeddings()` call your Foundry deployment from inside Postgres:

```bash
az postgres flexible-server parameter set \
  --resource-group bird-ticker-rg \
  --server-name bird-ticker-pg \
  --name azure_ai.openai_endpoint --value "<AZURE_OPENAI_ENDPOINT>"

az postgres flexible-server parameter set \
  --resource-group bird-ticker-rg \
  --server-name bird-ticker-pg \
  --name azure_ai.openai_subscription_key --value "<AZURE_OPENAI_KEY>"
```

### 4. Firewall Rules
Allow Azure-hosted services (covers the App Service outbound IPs). Add additional rules for any developer IPs that need direct access:

```bash
az postgres flexible-server firewall-rule create \
  --resource-group bird-ticker-rg \
  --name bird-ticker-pg \
  --rule-name allow-azure --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

### 5. Wire the Connection String into App Service
```bash
az webapp config appsettings set \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk \
  --settings DATABASE_URL="postgresql://birdapp:<password>@bird-ticker-pg.postgres.database.azure.com:5432/birdapp?sslmode=require"
```

### 6. Migrations
The app applies migrations on boot from `proxy/db/migrations/*.sql` in lexical order. `002_azure_ai.sql` runs `CREATE EXTENSION azure_ai`; that statement only succeeds on Azure Flexible Server (with the parameter from step 2) and is auto-skipped when running locally.

### 7. Verify
Connect and list installed extensions to confirm both are present:

```bash
az postgres flexible-server execute \
  --name bird-ticker-pg \
  --admin-user birdapp \
  --admin-password "<password>" \
  --database-name birdapp \
  --querytext "SELECT extname FROM pg_extension;"
```

Expected rows include `vector` and `azure_ai` alongside the defaults.

## Configuration

### App Settings (Azure Portal)
- **NODE_VERSION**: Set to `24-lts` or `24.x`
- **WEBSITE_HTTP_LOGGING_DISABLED**: `false`
- **Always On**: `true`

### Environment Variables
```
VAPID_PUBLIC=your_public_key
VAPID_PRIVATE=your_private_key
PORT=3000
DATABASE_URL=postgresql://birdapp:...@bird-ticker-pg.postgres.database.azure.com:5432/birdapp?sslmode=require
AZURE_OPENAI_ENDPOINT=...
AZURE_OPENAI_KEY=...
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-small
```

### Startup Command
```bash
npm start
```

## Updating the App

### Quick Update
```bash
# 1. Make code changes locally
# 2. Rebuild deployment package
cd /Users/ole/private/bird-app
rm -f bird-ticker-deploy.zip
zip -r bird-ticker-deploy.zip proxy/ public/ package.json .azure/config node_modules/

# 3. Redeploy
az webapp deploy \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk \
  --src-path bird-ticker-deploy.zip \
  --type zip
```

## Troubleshooting

### App Not Starting
```bash
# Check deployment logs
az webapp log tail --resource-group bird-ticker-rg --name bird-ticker-dk

# Check app settings
az webapp config show --resource-group bird-ticker-rg --name bird-ticker-dk

# Restart app
az webapp restart --resource-group bird-ticker-rg --name bird-ticker-dk
```

### Deployment Failed
```bash
# Check deployment history
az webapp deployment list-deployments \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk

# View deployment log
az resource show \
  --resource-type Microsoft.Web/deployments \
  --resource-group bird-ticker-rg \
  --parent "sites/bird-ticker-dk/default" \
  --name <deployment-name> \
  --query properties.logs
```

### Code Changes Not Applied
```bash
# Force deployment
az webapp deployment source config-zip \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk \
  --src bird-ticker-deploy.zip \
  --force

# Or use container log
az webapp log show --resource-group bird-ticker-rg --name bird-ticker-dk
```

## Monitoring

### Check App Health
```bash
# HTTP response
curl -I https://bird-ticker-dk.azurewebsites.net/
curl https://bird-ticker-dk.azurewebsites.net/api/ticklist?userId=5653&listType=1

# Application logs
az webapp log tail \
  --resource-group bird-ticker-rg \
  --name bird-ticker-dk
```

### Monitoring Setup (Optional)
Configure Azure Monitor alerts for:
- HTTP Failures
- CPU Usage
- Memory Utilization

## URLs
- Main App: https://bird-ticker-dk.azurewebsites.net
- Admin/Logs: https://bird-ticker-dk.scm.azurewebsites.net
- Health Check: https://bird-ticker-dk.azurewebsites.net/api/ticklist?userId=5653&listType=1

## Contact
For issues: Check Azure logs first, then review browser console for client-side errors.
