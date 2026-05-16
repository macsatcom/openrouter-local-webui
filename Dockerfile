FROM node:20-alpine

WORKDIR /app

# Install uv & uvx (required for MCP servers that run Python tools)
RUN apk add --no-cache curl && \
    curl -Lo uv.tar.gz "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-musl.tar.gz" && \
    tar -xzf uv.tar.gz -C /usr/local/bin --strip-components=1 && \
    rm uv.tar.gz

# Install Python 3 + pip (required for Python-based MCP servers)
RUN apk add --no-cache python3 py3-pip && \
    pip install --break-system-packages mcp

COPY package*.json ./
RUN npm install

COPY src/ ./src/
COPY static/ ./static/
RUN mkdir -p /app/generated-images /app/data

EXPOSE 3000

ENV DB_PATH=/app/data/chat.db
ENV IMAGES_DIR=/app/generated-images
ENV SESSION_SECRET=change-this-in-production

CMD ["node", "src/server.js"]