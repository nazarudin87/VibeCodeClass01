-- Run this in Supabase Dashboard -> SQL Editor for project
-- https://cdhauwtujmdfmhkfdorz.supabase.co

create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  completed boolean not null default false,
  progress integer not null default 0,
  parent_id uuid null references public.todos (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.todos enable row level security;

drop policy if exists "todos_owner_all" on public.todos;
create policy "todos_owner_all" on public.todos
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists todos_user_id_idx on public.todos (user_id);
create index if not exists todos_parent_id_idx on public.todos (parent_id);
