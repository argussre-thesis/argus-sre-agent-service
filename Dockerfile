# The Prisma client is generated code (gitignored), so it's built here with the dev dependencies.
FROM node:24-alpine AS prisma

WORKDIR /app

COPY package.json package-lock.json prisma.config.ts ./
RUN npm ci
COPY src/app/prisma/schema.prisma ./src/app/prisma/
RUN npx prisma generate

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src
COPY --from=prisma /app/src/app/prisma/generated ./src/app/prisma/generated

ENV HOST=0.0.0.0
EXPOSE 8090

USER 1000:1000

CMD ["node", "src/index.ts"]
