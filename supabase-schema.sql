-- ============================================================
-- Shadowing English · Supabase 建表 + 权限脚本
-- 用法：登录 Supabase → 左侧 SQL Editor → 粘贴全部 → Run
-- 可重复执行（create table if not exists），不会破坏已有数据
-- ============================================================

-- 1) 材料主表（含句子、元信息、音频路径）
create table if not exists public.materials (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text default '',
  audio_name  text default '',
  audio_path  text,
  sentences   jsonb not null default '[]'::jsonb,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2) 生词表（一个材料多条）
create table if not exists public.vocab (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  material_id      text not null,
  word             text default '',
  note             text default '',
  example          text default '',
  src_sentence_idx int,
  src_text         text default '',
  level            int not null default 0,
  reps             int not null default 0,
  due              timestamptz,
  last_review      timestamptz,
  last_grade       int,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 3) 学习进度表（一个材料一条，按 user_id+material_id 更新）
create table if not exists public.progress (
  user_id     uuid not null references auth.users(id) on delete cascade,
  material_id text not null,
  played      jsonb not null default '[]'::jsonb,
  hard        jsonb not null default '[]'::jsonb,
  last_index  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, material_id)
);

-- 4) 用户设置（记住上次用的材料）
create table if not exists public.user_settings (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  last_material_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ============================================================
-- 行级安全（RLS）：只允许本人读写自己的数据
-- 不配这一条，客户端会拿不到 / 写不进任何数据
-- ============================================================
alter table public.materials      enable row level security;
create policy materials_owner      on public.materials      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.vocab          enable row level security;
create policy vocab_owner          on public.vocab          for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.progress       enable row level security;
create policy progress_owner       on public.progress       for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.user_settings  enable row level security;
create policy user_settings_owner  on public.user_settings  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- 音频 Storage 桶（私有）：路径前缀 = uid/xxx.mp3
-- ============================================================
insert into storage.buckets (id, name, public)
values ('audio', 'audio', false)
on conflict (id) do update set public = false;

alter table storage.objects enable row level security;

drop policy if exists audio_owner on storage.objects;
create policy audio_owner on storage.objects for all
  using  (bucket_id = 'audio' and auth.uid()::text = (storage.foldername(name))[1])
  with check (bucket_id = 'audio' and auth.uid()::text = (storage.foldername(name))[1]);
