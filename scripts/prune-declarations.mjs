import { readdir, rm } from "node:fs/promises"

const distribution = new URL("../dist/", import.meta.url)
const files = await readdir(distribution)
await Promise.all(
  files
    .filter((file) => file.endsWith(".d.ts") && file !== "server.d.ts")
    .map((file) => rm(new URL(file, distribution))),
)
