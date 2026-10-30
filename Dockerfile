# Use the official Node 20 Alpine image (small and secure)
FROM node:20-alpine

# Set working directory INSIDE the functions folder
WORKDIR /app

# Copy the whole functions folder (package.json, package-lock.json, src/, index.js).
# Local node_modules is excluded via .dockerignore so the host (Windows) build
# never leaks into the Linux image — `npm ci` installs clean deps below.
COPY functions/ ./

# Install only production dependencies (uses package-lock.json)
RUN npm ci --omit=dev

# Expose port 8080 (Cloud Run / Firebase default)
EXPOSE 8080

# Start the Express server directly (not firebase shell).
# WORKDIR is /app and the functions/ *contents* were copied into it,
# so the entry file is /app/src/server.js  →  "src/server.js" is correct.
CMD ["node", "src/server.js"]
