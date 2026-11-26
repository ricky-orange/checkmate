FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --node-linker=hoisted
COPY server.mjs game.mjs ./
COPY public/ ./public/
ENV NODE_ENV=production HOST=0.0.0.0 SECURE_COOKIES=1
USER node
CMD ["node", "server.mjs"]
