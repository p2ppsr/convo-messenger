FROM node:22.18.0-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src

ENV NODE_ENV=production
USER node
CMD ["npm", "start"]
