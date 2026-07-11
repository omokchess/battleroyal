FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY game ./game
COPY multiplayer ./multiplayer
COPY server ./server
EXPOSE 8787
ENV NODE_ENV=production
CMD ["node", "server/index.mjs"]
