FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

RUN mkdir -p /app/data /tmp/feedback-call-recordings

EXPOSE 3000

CMD ["node", "index.js"]
