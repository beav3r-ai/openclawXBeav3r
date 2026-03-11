FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/openclaw-approvals/package.json packages/openclaw-approvals/package.json
COPY packages/openclaw-beav3r-bridge/package.json packages/openclaw-beav3r-bridge/package.json

RUN npm ci

COPY packages/openclaw-approvals packages/openclaw-approvals
COPY packages/openclaw-beav3r-bridge packages/openclaw-beav3r-bridge

RUN npm run --workspace @openclaw/openclaw-approvals build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/openclaw-approvals/package.json packages/openclaw-approvals/package.json
COPY packages/openclaw-beav3r-bridge/package.json packages/openclaw-beav3r-bridge/package.json

RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

CMD ["node", "dist/src/server-openclaw.js"]
