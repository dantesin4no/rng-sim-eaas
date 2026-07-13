# entropy-api — zero-dependency service, so no npm install needed
FROM node:22-slim
WORKDIR /app
COPY packages/entropy-core ./packages/entropy-core
COPY services/entropy-api ./services/entropy-api
COPY contracts ./contracts
# workspace link without npm
RUN mkdir -p services/entropy-api/node_modules/@entropy \
 && ln -s /app/packages/entropy-core services/entropy-api/node_modules/@entropy/core
ENV PORT=8787
EXPOSE 8787
# Docker itself observes the SP 800-90B health state: RCT/APT failure -> unhealthy container
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "services/entropy-api/src/server.js"]
