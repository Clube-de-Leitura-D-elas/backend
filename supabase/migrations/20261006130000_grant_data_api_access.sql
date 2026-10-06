-- As Edge Functions consultam estas tabelas pelo Data API usando service_role.
-- Projetos criados com a exposição automática desativada não concedem esses
-- privilégios para tabelas novas; por isso os grants precisam ser explícitos.
--
-- O painel web acessa o Data API diretamente apenas para cities, zones e users.
-- Os grants para authenticated dessas tabelas permanecem na migration
-- 20261006120000_grant_read_reference_tables.sql.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.book_reviews,
  public.book_suggestions,
  public.books,
  public.cities,
  public.genres,
  public.group_genres,
  public.group_users,
  public.groups,
  public.locations,
  public.meeting_group_users,
  public.meeting_photos,
  public.meetings,
  public.pending_users,
  public.photos,
  public.users,
  public.zones
TO service_role;
