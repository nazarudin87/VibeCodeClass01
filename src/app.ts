import express from "express";
import path from "node:path";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
  supabaseAnon,
  userClient,
} from "./supabase.js";

const app = express();

app.use(express.json());

app.use(express.static(path.join(process.cwd(), "public")));

type Todo = {
  id: string;
  name: string;
  completed: boolean;
  progress: number; // 0-100
  parentId: string | null; // null = big project, string = sub-task
  createdAt: string;
  updatedAt: string;
};

type DbTodo = {
  id: string;
  user_id: string;
  name: string;
  completed: boolean;
  progress: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
};

function toApi(r: DbTodo): Todo {
  return {
    id: r.id,
    name: r.name,
    completed: r.completed,
    progress: r.progress,
    parentId: r.parent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function clampProgress(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// ---- auth ----

async function requireUser(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!isSupabaseConfigured || !supabaseAnon) {
    res.status(503).json({ error: "supabase not configured (SUPABASE_URL / SUPABASE_ANON_KEY)" });
    return;
  }
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "missing bearer token" });
    return;
  }
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }
  (req as unknown as { userId: string }).userId = data.user.id;
  (req as unknown as { userToken: string }).userToken = token;
  next();
}

function dbOf(req: express.Request) {
  const { userId, userToken } = req as unknown as { userId: string; userToken: string };
  const db = userClient(userToken);
  return { db, userId };
}

// ---- rollup helpers (operate on the user's rows) ----

function childrenOf(all: DbTodo[], projectId: string): DbTodo[] {
  return all.filter((t) => t.parent_id === projectId);
}

async function refreshProject(
  db: ReturnType<typeof userClient>,
  userId: string,
  all: DbTodo[],
  projectId: string,
): Promise<void> {
  const project = all.find((t) => t.id === projectId && t.parent_id === null);
  if (!project) return;
  const children = childrenOf(all, projectId);
  if (children.length === 0) return; // standalone project keeps its own progress
  const avg = Math.round(children.reduce((s, c) => s + c.progress, 0) / children.length);
  const completed = children.every((c) => c.completed);
  const { error } = await db
    .from("todos")
    .update({ progress: avg, completed, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId);
  if (!error) {
    project.progress = avg;
    project.completed = completed;
  }
}

async function listAll(db: ReturnType<typeof userClient>, userId: string): Promise<DbTodo[]> {
  const { data, error } = await db
    .from("todos")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as DbTodo[];
}

function projectView(all: DbTodo[], project: DbTodo) {
  const subtasks = childrenOf(all, project.id).map(toApi);
  const total = subtasks.length;
  const done = subtasks.filter((s) => s.completed).length;
  return { ...toApi(project), total, done, subtasks };
}

// ---- public routes ----

app.get("/health", (_req, res) => {
  res.json({ ok: true, supabase: isSupabaseConfigured });
});

// Public Supabase credentials for the browser (anon key is public by design).
app.get("/api/config", (_req, res) => {
  if (!isSupabaseConfigured) {
    res.status(503).json({ error: "supabase not configured" });
    return;
  }
  res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

// ---- protected routes (per-user todos) ----

// Aggregated view: big projects with rollup progress + subtasks
app.get("/api/projects", requireUser, async (req, res) => {
  try {
    const { db, userId } = dbOf(req);
    const all = await listAll(db, userId);
    res.json(all.filter((t) => t.parent_id === null).map((p) => projectView(all, p)));
  } catch {
    res.status(500).json({ error: "failed to load projects" });
  }
});

app.get("/api/items", requireUser, async (req, res) => {
  try {
    const { db, userId } = dbOf(req);
    const all = await listAll(db, userId);
    let result = all;
    const { completed, parentId } = req.query;
    if (parentId !== undefined) {
      if (parentId === "null") {
        result = result.filter((t) => t.parent_id === null);
      } else if (typeof parentId === "string" && parentId !== "") {
        result = result.filter((t) => t.parent_id === parentId);
      } else {
        res.status(400).json({ error: "parentId must be an id or 'null'" });
        return;
      }
    }
    if (completed !== undefined) {
      if (completed !== "true" && completed !== "false") {
        res.status(400).json({ error: "completed query must be 'true' or 'false'" });
        return;
      }
      const flag = completed === "true";
      result = result.filter((t) => t.completed === flag);
    }
    res.json(result.map(toApi));
  } catch {
    res.status(500).json({ error: "failed to load items" });
  }
});

app.post("/api/items", requireUser, async (req, res) => {
  try {
    const { db, userId } = dbOf(req);
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    let parent_id: string | null = null;
    if (req.body?.parentId !== undefined && req.body?.parentId !== null && req.body?.parentId !== "") {
      const pid = String(req.body.parentId);
      const { data: parent, error: parentErr } = await db
        .from("todos")
        .select("id,parent_id")
        .eq("id", pid)
        .eq("user_id", userId)
        .maybeSingle();
      if (parentErr || !parent || (parent as DbTodo).parent_id !== null) {
        res.status(400).json({ error: "parent project not found (sub-tasks can only belong to a big project)" });
        return;
      }
      parent_id = pid;
    }
    let progress = 0;
    if (req.body?.progress !== undefined) {
      const p = clampProgress(req.body.progress);
      if (p === null) {
        res.status(400).json({ error: "progress must be a number 0-100" });
        return;
      }
      progress = p;
    } else if (req.body?.completed === true) {
      progress = 100;
    } else if (req.body?.completed !== undefined && typeof req.body.completed !== "boolean") {
      res.status(400).json({ error: "completed must be a boolean" });
      return;
    }
    const { data, error } = await db
      .from("todos")
      .insert({ user_id: userId, name, completed: progress >= 100, progress, parent_id })
      .select("*")
      .single();
    if (error || !data) {
      res.status(500).json({ error: "failed to create item" });
      return;
    }
    if (parent_id !== null) {
      const all = await listAll(db, userId);
      await refreshProject(db, userId, all, parent_id);
    }
    res.status(201).json(toApi(data as DbTodo));
  } catch {
    res.status(500).json({ error: "failed to create item" });
  }
});

app.get("/api/items/:id", requireUser, async (req, res) => {
  try {
    const { db, userId } = dbOf(req);
    const { data, error } = await db
      .from("todos")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const item = data as DbTodo;
    if (item.parent_id === null) {
      const all = await listAll(db, userId);
      await refreshProject(db, userId, all, item.id);
      const fresh = all.find((t) => t.id === item.id) ?? item;
      res.json(projectView(all, fresh));
      return;
    }
    res.json(toApi(item));
  } catch {
    res.status(500).json({ error: "failed to load item" });
  }
});

app.patch("/api/items/:id", requireUser, async (req, res) => {
  try {
    const { db, userId } = dbOf(req);
    const { data: row, error: fetchErr } = await db
      .from("todos")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (fetchErr || !row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const item = row as DbTodo;
    const all = await listAll(db, userId);
    const isRollupProject =
      item.parent_id === null && childrenOf(all, item.id).length > 0;
    const hasName = req.body?.name !== undefined;
    const hasCompleted = req.body?.completed !== undefined;
    const hasProgress = req.body?.progress !== undefined;
    if (!hasName && !hasCompleted && !hasProgress) {
      res.status(400).json({ error: "provide name, completed and/or progress" });
      return;
    }
    const patch: Partial<DbTodo> = {};
    if (hasName) {
      const name = String(req.body.name ?? "").trim();
      if (!name) {
        res.status(400).json({ error: "name must be a non-empty string" });
        return;
      }
      patch.name = name;
    }
    let progress = item.progress;
    let completed = item.completed;
    if (hasProgress) {
      if (isRollupProject) {
        res.status(400).json({ error: "project progress is computed from its sub-tasks" });
        return;
      }
      const p = clampProgress(req.body.progress);
      if (p === null) {
        res.status(400).json({ error: "progress must be a number 0-100" });
        return;
      }
      progress = p;
      completed = p >= 100;
    }
    if (hasCompleted) {
      if (typeof req.body.completed !== "boolean") {
        res.status(400).json({ error: "completed must be a boolean" });
        return;
      }
      if (isRollupProject) {
        res.status(400).json({ error: "project completion is computed from its sub-tasks" });
        return;
      }
      if (!hasProgress) {
        completed = req.body.completed;
        progress = req.body.completed ? 100 : progress >= 100 ? 0 : progress;
      } else if (req.body.completed && progress < 100) {
        progress = 100;
        completed = true;
      } else if (!req.body.completed && progress >= 100) {
        progress = 0;
        completed = false;
      }
    }
    const { data: updated, error: updateErr } = await db
      .from("todos")
      .update({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        progress,
        completed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (updateErr || !updated) {
      res.status(500).json({ error: "failed to update item" });
      return;
    }
    const saved = updated as DbTodo;
    if (saved.parent_id !== null) {
      const fresh = await listAll(db, userId);
      await refreshProject(db, userId, fresh, saved.parent_id);
      res.json(toApi(saved));
      return;
    }
    const fresh = await listAll(db, userId);
    const current = fresh.find((t) => t.id === saved.id) ?? saved;
    res.json(projectView(fresh, current));
  } catch {
    res.status(500).json({ error: "failed to update item" });
  }
});

app.delete("/api/items/:id", requireUser, async (req, res) => {
  try {
    const { db, userId } = dbOf(req);
    const { data: target, error: fetchErr } = await db
      .from("todos")
      .select("id,parent_id")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (fetchErr || !target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const t = target as Pick<DbTodo, "id" | "parent_id">;
    // big project: DB foreign key cascades to its sub-tasks
    const { error: delErr } = await db
      .from("todos")
      .delete()
      .eq("id", t.id)
      .eq("user_id", userId);
    if (delErr) {
      res.status(500).json({ error: "failed to delete item" });
      return;
    }
    if (t.parent_id !== null) {
      const fresh = await listAll(db, userId);
      await refreshProject(db, userId, fresh, t.parent_id);
    }
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "failed to delete item" });
  }
});

app.delete("/api/items", requireUser, async (req, res) => {
  try {
    if (req.query.completed !== "true") {
      res.status(400).json({ error: "use DELETE /api/items?completed=true to clear completed" });
      return;
    }
    const { db, userId } = dbOf(req);
    const { data: gone, error: delErr } = await db
      .from("todos")
      .delete()
      .eq("completed", true)
      .eq("user_id", userId)
      .select("id");
    if (delErr) {
      res.status(500).json({ error: "failed to clear completed" });
      return;
    }
    const deleted = (gone ?? []).length;
    const fresh = await listAll(db, userId);
    for (const t of fresh) {
      if (t.parent_id === null) await refreshProject(db, userId, fresh, t.id);
    }
    res.json({ deleted });
  } catch {
    res.status(500).json({ error: "failed to clear completed" });
  }
});

export default app;
