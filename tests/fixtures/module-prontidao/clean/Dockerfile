FROM node@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src/ ./src/
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
