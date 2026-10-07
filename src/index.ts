import app from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);

// On Vercel the Express app is served via api/index.ts (serverless),
// so only listen in local/long-running environments.
if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
  });
}

export default app;
