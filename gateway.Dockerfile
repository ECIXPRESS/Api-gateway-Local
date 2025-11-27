FROM node:18-alpine3.18
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY gateway-multiple-services.js ./
EXPOSE 8081
CMD ["node", "gateway-multiple-services.js"]