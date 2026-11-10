FROM node:24-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Set environment
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
