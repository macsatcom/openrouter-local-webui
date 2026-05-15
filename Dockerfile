FROM node:20-alpine

WORKDIR /app

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