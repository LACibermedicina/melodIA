FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 DATA_DIR=/data PORT=3000
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
