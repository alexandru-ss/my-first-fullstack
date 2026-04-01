-- Tags: per-user vocabulary
create table public.tags (
  id      bigint generated always as identity primary key,
  user_id uuid   not null references public.users(id) on delete cascade,
  name    text   not null,
  unique (user_id, name)
);

comment on table public.tags is 'User-owned tag vocabulary.';

create index tags_user_id_idx on public.tags (user_id);

create table public.note_tags (
  note_id bigint not null references public.notes(id) on delete cascade,
  tag_id  bigint not null references public.tags(id)  on delete cascade,
  primary key (note_id, tag_id)
);

comment on table public.note_tags is 'Many-to-many link between notes and tags.';

create index note_tags_tag_id_idx on public.note_tags (tag_id);

alter table public.tags      enable row level security;
alter table public.note_tags enable row level security;
alter table public.tags      force row level security;
alter table public.note_tags force row level security;

create policy "tags: select own" on public.tags
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "tags: insert own" on public.tags
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "tags: update own" on public.tags
  for update to authenticated
  using  ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "tags: delete own" on public.tags
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "note_tags: select own" on public.note_tags
  for select to authenticated
  using (
    exists (
      select 1 from public.notes
      where id = note_tags.note_id
        and user_id = (select auth.uid())
    )
  );

create policy "note_tags: insert own" on public.note_tags
  for insert to authenticated
  with check (
    exists (
      select 1 from public.notes
      where id = note_tags.note_id
        and user_id = (select auth.uid())
    )
  );

create policy "note_tags: delete own" on public.note_tags
  for delete to authenticated
  using (
    exists (
      select 1 from public.notes
      where id = note_tags.note_id
        and user_id = (select auth.uid())
    )
  );