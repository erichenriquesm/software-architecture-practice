FROM node:26-alpine AS deps
RUN apk add --no-cache protobuf
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS dev
COPY . .
RUN npm run proto:gen
CMD ["npx", "tsx", "watch", "src/infra/api.ts"]

FROM dev AS build
RUN npm run check && npm run build

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist dist
COPY src/infra/contracts src/infra/contracts
USER node
CMD ["node", "dist/infra/api.js"]
