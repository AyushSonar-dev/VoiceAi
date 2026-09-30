FROM node:20-alpine
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/

# Install backend deps only
RUN npm install --workspace=backend --ignore-scripts

# Copy backend source
COPY backend/ ./backend/

EXPOSE 4000

CMD ["node", "--import", "tsx/esm", "backend/src/index.ts"]
