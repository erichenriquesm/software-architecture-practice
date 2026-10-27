# === Estágio 1: Build ===
FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
# Testes rodam antes do build: se algum falhar, a imagem não é gerada.
RUN npm run test:run
RUN npm run build


# === Estágio 2: Imagem final ===
FROM node:26-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
