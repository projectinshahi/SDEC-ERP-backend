import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "src/prisma/schema.prisma",
  datasource: {
    url: "postgresql://neondb_owner:npg_3kixXJENWyM8@ep-round-silence-aos4let2.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
  },
});
