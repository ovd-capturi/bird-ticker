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
