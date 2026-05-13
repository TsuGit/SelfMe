import { bootstrapApp } from "./app/bootstrap.js";

const forceNewSession = process.argv.includes("--new");
const sessionArgIndex = process.argv.findIndex((value) => value === "--session");
const sessionId = sessionArgIndex >= 0
  ? process.argv[sessionArgIndex + 1]
  : undefined;

const app = await bootstrapApp({
  forceNewSession,
  sessionId
});
await app.start();
