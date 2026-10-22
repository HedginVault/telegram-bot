FROM node:22.23.4-slim AS build
WORKDIR /bot
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build && yarn install --frozen-lockfile --production

FROM node:22.23.4-slim
WORKDIR /bot
ENV NODE_ENV=production
COPY --from=build /bot/node_modules ./node_modules
COPY --from=build /bot/dist ./dist
COPY package.json ./
USER node
CMD ["node", "dist/src/index.js"]
