# Use the official Node 20 Alpine image (small and secure)
FROM node:20-alpine

# Set working directory INSIDE the functions folder
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY functions/package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy the rest of the functions source code
COPY functions/ ./

# Expose port 8080 (Cloud Run / Firebase default)
EXPOSE 8080

# Start the Express server directly (not firebase shell)
CMD ["node", "src/server.js"]
