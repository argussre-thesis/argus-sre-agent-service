import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

// Prisma's CLI doesn't read .env, and the npm scripts' --env-file doesn't reach it. As with --env-file, the shell wins.
if (existsSync(".env")) process.loadEnvFile();

export default defineConfig({
  schema: "src/app/prisma/schema.prisma",
  migrations: {
    path: "src/app/prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
