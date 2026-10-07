import app from "../src/app.js";

// Vercel serverless entry point. vercel.json rewrites /api/* here,
// and the Express app handles routing. Storage falls back to /tmp
// (see src/app.ts) since the serverless filesystem is ephemeral.
export default app;
