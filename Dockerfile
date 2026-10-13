# Optional: run the game server in a container as an unprivileged user.
#   docker build -t whose-is-it-server .
#   docker run --rm -p 127.0.0.1:3000:3000 whose-is-it-server
FROM node:22-alpine
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY src/shared ./src/shared
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/index.ts"]
