import express from "express";
import fs from "node:fs";
import path from "node:path";

const app = express();

app.use(express.json());

app.use(express.static(path.join(process.cwd(), "public")));

type Todo = {
  id: number;
  name: string;
  completed: boolean;
  progress: number; // 0-100
  parentId: number | null; // null = big project, number = sub-task
  createdAt: string;
  updatedAt: string;
};

// Vercel serverless filesystem is read-only except /tmp (and ephemeral),
// so writes fall back to /tmp there and never crash the request.
const DATA_FILE =
  process.env.VERCEL === "1"
    ? path.join("/tmp", "todos.json")
    : path.join(process.cwd(), "data", "todos.json");

function nowIso(): string {
  return new Date().toISOString();
}

function clampProgress(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function toTodo(raw: unknown, fallbackId: number): Todo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : fallbackId;
  const name = typeof r.name === "string" ? r.name : "";
  if (!name.trim()) return null;
  const completedRaw = r.completed === true;
  const progressRaw = clampProgress(r.progress);
  const progress = progressRaw ?? (completedRaw ? 100 : 0);
  const parentId = typeof r.parentId === "number" ? r.parentId : null;
  return {
    id,
    name: name.trim(),
    completed: progress >= 100 ? true : completedRaw && progress >= 100,
    progress,
    parentId,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : nowIso(),
  };
}

function loadTodos(): Todo[] {
  try {
    if (!fs.existsSync(DATA_FILE)) return [{ id: 1, name: "hello world", completed: false, progress: 0, parentId: null, createdAt: nowIso(), updatedAt: nowIso() }];
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    const todos: Todo[] = [];
    let fallbackId = 1;
    for (const entry of raw) {
      const todo = toTodo(entry, fallbackId);
      if (todo) {
        // drop orphan subtasks whose parent is missing (repaired after load)
        todos.push(todo);
        fallbackId = Math.max(fallbackId, todo.id + 1);
      }
    }
    const ids = new Set(todos.map((t) => t.id));
    for (const t of todos) {
      if (t.parentId !== null && !ids.has(t.parentId)) t.parentId = null;
    }
    // recompute project rollups so stored progress matches children
    for (const t of todos) {
      if (t.parentId === null) refreshProjectInPlace(todos, t.id);
    }
    return todos;
  } catch {
    return [{ id: 1, name: "hello world", completed: false, progress: 0, parentId: null, createdAt: nowIso(), updatedAt: nowIso() }];
  }
}

function childrenOf(all: Todo[], projectId: number): Todo[] {
  return all.filter((t) => t.parentId === projectId);
}

function refreshProjectInPlace(all: Todo[], projectId: number): void {
  const project = all.find((t) => t.id === projectId && t.parentId === null);
  if (!project) return;
  const children = childrenOf(all, projectId);
  if (children.length === 0) return; // standalone project keeps its own progress
  const avg = Math.round(children.reduce((s, c) => s + c.progress, 0) / children.length);
  project.progress = avg;
  project.completed = children.every((c) => c.completed);
  project.updatedAt = nowIso();
}

let todos: Todo[] = loadTodos();
let nextId = todos.reduce((m, t) => Math.max(m, t.id + 1), 1);

function saveTodos(): void {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(todos, null, 2) + "\n");
  } catch {
    // Filesystem may be read-only/ephemeral (e.g. Vercel serverless);
    // the API keeps serving in-memory data instead of crashing.
  }
}

// Persist seed on first run so restart keeps data
try {
  if (!fs.existsSync(DATA_FILE)) saveTodos();
} catch {
  // ignore seed persistence errors; API still serves in-memory
}

function projectView(project: Todo) {
  const subtasks = childrenOf(todos, project.id);
  const total = subtasks.length;
  const done = subtasks.filter((s) => s.completed).length;
  return { ...project, total, done, subtasks };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Aggregated view: big projects with rollup progress + subtasks
app.get("/api/projects", (_req, res) => {
  res.json(todos.filter((t) => t.parentId === null).map(projectView));
});

app.get("/api/items", (req, res) => {
  const { completed, parentId } = req.query;
  let result = todos;
  if (parentId !== undefined) {
    if (parentId === "null") {
      result = result.filter((t) => t.parentId === null);
    } else {
      const pid = Number(parentId);
      if (!Number.isInteger(pid)) {
        res.status(400).json({ error: "parentId must be an id or 'null'" });
        return;
      }
      result = result.filter((t) => t.parentId === pid);
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
  res.json(result);
});

app.post("/api/items", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  let parentId: number | null = null;
  if (req.body?.parentId !== undefined && req.body?.parentId !== null) {
    const pid = Number(req.body.parentId);
    if (!Number.isInteger(pid)) {
      res.status(400).json({ error: "parentId must be a project id" });
      return;
    }
    const parent = todos.find((t) => t.id === pid && t.parentId === null);
    if (!parent) {
      res.status(400).json({ error: "parent project not found (sub-tasks can only belong to a big project)" });
      return;
    }
    parentId = pid;
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
  const timestamp = nowIso();
  const item: Todo = {
    id: nextId++,
    name,
    completed: progress >= 100,
    progress,
    parentId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  todos.push(item);
  if (parentId !== null) refreshProjectInPlace(todos, parentId);
  saveTodos();
  res.status(201).json(item);
});

app.get("/api/items/:id", (req, res) => {
  const item = todos.find((i) => i.id === Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (item.parentId === null) {
    refreshProjectInPlace(todos, item.id);
    res.json(projectView(item));
    return;
  }
  res.json(item);
});

app.patch("/api/items/:id", (req, res) => {
  const item = todos.find((i) => i.id === Number(req.params.id));
  if (!item) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const isRollupProject = item.parentId === null && childrenOf(todos, item.id).length > 0;
  const hasName = req.body?.name !== undefined;
  const hasCompleted = req.body?.completed !== undefined;
  const hasProgress = req.body?.progress !== undefined;
  if (!hasName && !hasCompleted && !hasProgress) {
    res.status(400).json({ error: "provide name, completed and/or progress" });
    return;
  }
  if (hasName) {
    const name = String(req.body.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    item.name = name;
  }
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
    item.progress = p;
    item.completed = p >= 100;
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
    // completed flag stays in sync with progress
    if (!hasProgress) {
      item.completed = req.body.completed;
      item.progress = req.body.completed ? 100 : item.progress >= 100 ? 0 : item.progress;
    } else {
      item.completed = item.progress >= 100 ? true : req.body.completed && item.progress >= 100;
      if (req.body.completed && item.progress < 100) {
        // explicit complete wins over a partial progress in the same request
        item.progress = 100;
        item.completed = true;
      }
      if (!req.body.completed && item.progress >= 100) {
        item.progress = 0;
        item.completed = false;
      }
    }
  }
  item.updatedAt = nowIso();
  if (item.parentId !== null) refreshProjectInPlace(todos, item.parentId);
  saveTodos();
  if (item.parentId === null) {
    res.json(projectView(item));
    return;
  }
  res.json(item);
});

app.delete("/api/items/:id", (req, res) => {
  const id = Number(req.params.id);
  const target = todos.find((i) => i.id === id);
  if (!target) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const parentId = target.parentId;
  if (target.parentId === null) {
    // big project: cascade delete its sub-tasks
    todos = todos.filter((i) => i.id !== id && i.parentId !== id);
  } else {
    todos = todos.filter((i) => i.id !== id);
  }
  if (parentId !== null) {
    const parent = todos.find((t) => t.id === parentId && t.parentId === null);
    if (parent) refreshProjectInPlace(todos, parentId);
  }
  saveTodos();
  res.status(204).end();
});

app.delete("/api/items", (req, res) => {
  if (req.query.completed !== "true") {
    res.status(400).json({ error: "use DELETE /api/items?completed=true to clear completed" });
    return;
  }
  const before = todos.length;
  todos = todos.filter((t) => !t.completed);
  const deleted = before - todos.length;
  // repair orphans + refresh rollups after bulk delete
  const ids = new Set(todos.map((t) => t.id));
  for (const t of todos) {
    if (t.parentId !== null && !ids.has(t.parentId)) t.parentId = null;
  }
  for (const t of todos) {
    if (t.parentId === null) refreshProjectInPlace(todos, t.id);
  }
  saveTodos();
  res.json({ deleted });
});

export default app;
