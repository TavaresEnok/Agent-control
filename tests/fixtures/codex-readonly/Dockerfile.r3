FROM node:22-alpine
COPY app-server.mjs /fixture.mjs
ENTRYPOINT ["node","/fixture.mjs"]
