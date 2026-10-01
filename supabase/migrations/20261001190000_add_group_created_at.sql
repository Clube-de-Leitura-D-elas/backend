-- Data de criação do grupo, exibida na lista de grupos do painel web.
--
-- Grupos já existentes não têm registro de quando foram criados: o backfill usa
-- a data do primeiro encontro do grupo e fica com o momento da migration quando
-- não há encontro anterior a ele. O backfill só roda junto com a criação da
-- coluna, para não sobrescrever datas se a migration for reaplicada.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'groups'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE public.groups
    ADD COLUMN created_at timestamp with time zone NOT NULL DEFAULT now();

    UPDATE public.groups g
    SET created_at = first_meeting.date
    FROM (
      SELECT group_id, min(date) AS date
      FROM public.meetings
      WHERE date IS NOT NULL
      GROUP BY group_id
    ) first_meeting
    WHERE first_meeting.group_id = g.id
      AND first_meeting.date < g.created_at;
  END IF;
END
$$;
