# VibeCodeClass01 — Todo Projects

Big projects with sub-tasks. Project progress rolls up from sub-tasks
(average progress; completed when all sub-tasks are done).

## Run locally

```sh
npm install
npm run dev
# UI: http://localhost:3000/
# GET http://localhost:3000/health
# GET http://localhost:3000/api/projects
```

## Endpoints

- `GET /health` -> `{ ok: true }`
- `GET /api/projects` — big projects with `{ progress, total, done, subtasks }`
- `GET /api/items` — optional `?parentId=<id|null>` and `?completed=true|false`
- `POST /api/items` with `{ "name": "...", "parentId": null, "progress": 0 }`
- `GET /api/items/:id` — projects include rollup + `subtasks`
- `PATCH /api/items/:id` with `{ "name"?, "completed"?, "progress"? 0-100 }`
- `DELETE /api/items/:id` — deleting a project cascades to its sub-tasks
- `DELETE /api/items?completed=true` — clear completed

## UI rules

- Project penguin: `<=20%` sad, `21-79%` walking, `>=80%` jumping.
- Completing a sub-task shows a jumping penguin next to it for ~2.5s.

## Publish to GitHub

```sh
git add -A
git commit -m "Todo projects with Vercel support"
git push -u origin main
```

Remote is `git@github.com:nazarudin87/VibeCodeClass01.git` (SSH key required).

## Deploy to Vercel

- `vercel.json` rewrites `/api/*` to the `api/index.ts` serverless function,
  which reuses the same Express app as local (`src/app.ts`).
- `public/` is served as static files; `/` serves the UI.
- Storage note: Vercel's filesystem is ephemeral — the app writes to
  `/tmp/todos.json` there and serves in-memory data, so todos reset between
  cold starts. For permanent storage, add a database (e.g. Vercel KV/Postgres)
  behind the same endpoints.

```sh
vercel
vercel --prod
```
