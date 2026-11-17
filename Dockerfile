FROM node:22-alpine
WORKDIR /app
COPY server.js mcp.js ./
COPY public ./public
USER node
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.js"]
