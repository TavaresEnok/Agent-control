FROM node:22-bookworm
WORKDIR /app
COPY package.json src ./
USER root
CMD ["node", "src/tls-client.ts"]
