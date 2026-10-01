-- Toris Studio cloud schema.
-- Local MVP runs without Supabase; apply this when the Supabase project is created.

create extension if not exists pgcrypto;

create table if not exists public.video_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  title text not null,
  format text not null check (format in ('youtube-landscape', 'vertical', 'shorts')),
  language text not null default 'ko' check (language in ('ko', 'ja', 'zh', 'en')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.video_renders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  project_id uuid not null references public.video_projects(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'rendering', 'completed', 'failed')),
  engine text not null default 'remotion',
  output_path text,
  width integer,
  height integer,
  duration_seconds numeric,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  owner_id uuid references auth.users(id) on delete cascade,
  project_id uuid references public.video_projects(id) on delete set null,
  metric text not null
    check (metric in ('render_second', 'tts_character', 'stt_second', 'youtube_upload')),
  quantity numeric not null check (quantity >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  plan text not null default 'trial',
  status text not null default 'trialing',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists video_projects_owner_updated_idx
  on public.video_projects (owner_id, updated_at desc);

create index if not exists video_renders_project_created_idx
  on public.video_renders (project_id, created_at desc);

create index if not exists usage_events_owner_created_idx
  on public.usage_events (owner_id, created_at desc);

alter table public.video_projects enable row level security;
alter table public.video_renders enable row level security;
alter table public.usage_events enable row level security;
alter table public.subscriptions enable row level security;

grant select, insert, update, delete on public.video_projects to authenticated;
grant select, insert, update, delete on public.video_renders to authenticated;
grant select, insert on public.usage_events to authenticated;
grant select on public.subscriptions to authenticated;

create policy "video_projects_select_own"
  on public.video_projects for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "video_projects_insert_own"
  on public.video_projects for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "video_projects_update_own"
  on public.video_projects for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "video_projects_delete_own"
  on public.video_projects for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "video_renders_select_own"
  on public.video_renders for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "video_renders_insert_own"
  on public.video_renders for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "video_renders_update_own"
  on public.video_renders for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

create policy "video_renders_delete_own"
  on public.video_renders for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "usage_events_select_own"
  on public.usage_events for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "usage_events_insert_own"
  on public.usage_events for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

create policy "subscriptions_select_own"
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public)
values ('toris-studio-assets', 'toris-studio-assets', false)
on conflict (id) do update set public = false;

create policy "toris_assets_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'toris-studio-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "toris_assets_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'toris-studio-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "toris_assets_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'toris-studio-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'toris-studio-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "toris_assets_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'toris-studio-assets'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
