# Build context: the repository root (see compose.yaml). The server reuses the device's
# package and WAV checks from src/node, so they must be in the image too.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY src/node ./src/node
COPY src/ui/la2l-logo-big.png ./server/public/logo.png
COPY server/package.json ./server/
COPY server/src ./server/src
COPY server/public ./server/public
COPY examples/web-drum-machine ./examples/web-drum-machine
WORKDIR /app/server
# A new volume takes the owner of its folder from the image: the server writes /data, and
# deploy/maven-sync.sh fills /maven as this user too.
RUN mkdir -p /data /maven && chown node:node /data /maven
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
