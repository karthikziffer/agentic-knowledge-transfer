FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Apply any pending migrations against the live database before serving
# traffic, then start the app.
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
