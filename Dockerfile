FROM node:22-alpine

WORKDIR /app

COPY hub-plataformas/package*.json ./
RUN npm install --omit=dev

COPY hub-plataformas/ .

EXPOSE 3000

CMD ["node", "server.js"]
