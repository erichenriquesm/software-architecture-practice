FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src src
USER node
CMD ["npm", "test"]
