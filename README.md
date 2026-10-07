# VibeCodeClass01 — Todo Projects

Big projects with sub-tasks, per-user data in Supabase Postgres.
Project progress rolls up from sub-tasks
(average progress; completed when all sub-tasks are done).

## Run locally

```sh
npm install
# .env (gitignored): SUPABASE_URL, SUPABASE_ANON_KEY, PORT
npm run dev
# UI: http://localhost:3000/
# GET http://localhost:3000/health
# GET http://localhost:3000/api/projects (needs Bearer JWT)
```

## Supabase setup (one-time, dashboard)

1. SQL Editor → run `supabase/schema.sql` (creates `todos` table + RLS so
   users only see their own rows).
2. Authentication → URL Configuration → add to redirect URLs:
   `http://localhost:3000` and your Vercel domain
   (required for the password-reset email link to return to the app).
3. If email confirmation blocks testing: either confirm the test user via
   its email, or turn off "Confirm email" under Authentication → Providers → Email.

## Endpoints

- `GET /health` -> `{ ok: true, supabase: true }`
- `GET /api/config` — public Supabase URL + anon key for the browser
- `GET /api/projects` — big projects with `{ progress, total, done, subtasks }`
- `GET /api/items` — optional `?parentId=<id|null>` and `?completed=true|false`
- `POST /api/items` with `{ "name": "...", "parentId": null, "progress": 0 }`
- `GET /api/items/:id` — projects include rollup + `subtasks`
- `PATCH /api/items/:id` with `{ "name"?, "completed"?, "progress"? 0-100 }`
- `DELETE /api/items/:id` — deleting a project cascades to its sub-tasks
- `DELETE /api/items?completed=true` — clear completed

All `/api/*` except `/api/config` require
`Authorization: Bearer <supabase access token>`.

## UI rules

- Sign in / sign up / forgot-password on first load; reset link emails a
  link back to `/`, where you set a new password.
- Project penguin: `<=20%` sad, `21-79%` walking, `>=80%` jumping.
- Completing a sub-task shows a jumping penguin next to it for ~2.5s.

## Publish to GitHub

```sh
git add -A
git commit -m "..."
git push -u origin main
```

## Deploy to Vercel

- `vercel.json` rewrites `/api/*` to the `api/index.ts` serverless function,
  which reuses the same Express app as local (`src/app.ts`).
- `public/` is served as static files; `/` serves the UI.
- Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Vercel → Settings →
  Environment Variables (todo data lives in Supabase, so it persists —
  unlike the old `/tmp` JSON file).
