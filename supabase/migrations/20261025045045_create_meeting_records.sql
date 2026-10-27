CREATE TABLE public.meeting_records (
    meeting_id uuid NOT NULL,
    summary text NOT NULL DEFAULT '',
    published_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meeting_records_pkey PRIMARY KEY (meeting_id),
    CONSTRAINT meeting_records_meeting_id_fkey
        FOREIGN KEY (meeting_id) REFERENCES public.meetings(id)
);

-- Encerrado = publicado. Não encerrado com fotos = rascunho.
INSERT INTO public.meeting_records (meeting_id, published_at)
SELECT m.id, CASE WHEN m.status = 'CONCLUDED' THEN now() END
FROM public.meetings m
WHERE m.status = 'CONCLUDED'
   OR EXISTS (SELECT 1 FROM public.meeting_photos p WHERE p.meeting_id = m.id)
ON CONFLICT (meeting_id) DO NOTHING;

-- Legenda por foto. O rascunho passa a ser do registro inteiro, então o
-- `is_sketch` de cada foto deixa de existir.
ALTER TABLE public.meeting_photos RENAME COLUMN description TO caption;
UPDATE public.meeting_photos SET caption = '' WHERE caption IS NULL;
ALTER TABLE public.meeting_photos
    ALTER COLUMN caption SET DEFAULT '',
    ALTER COLUMN caption SET NOT NULL,
    DROP COLUMN is_sketch;