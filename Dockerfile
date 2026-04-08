FROM node:20-slim

WORKDIR /app

# Install proxy dependencies
COPY proxy/package*.json ./proxy/
RUN cd proxy && npm ci --production

# Copy app files
COPY proxy/ ./proxy/
COPY public/ ./public/

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "proxy/server.js"]
