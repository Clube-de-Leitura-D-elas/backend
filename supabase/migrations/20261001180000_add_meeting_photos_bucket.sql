-- Fotos do encontro enviadas pelo app. Bucket privado: a leitura é feita só por
-- signed URL gerada nas edge functions, que usam a service role.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'meeting-photos',
    'meeting-photos',
    false,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;

-- `uploaded_at` é só data; a galeria precisa da ordem de envio.
ALTER TABLE public.photos
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- Garante o teto de fotos por encontro mesmo com envios concorrentes: o lock
-- na linha do encontro serializa os inserts do mesmo encontro.
CREATE OR REPLACE FUNCTION public.enforce_meeting_photos_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM 1 FROM public.meetings WHERE id = NEW.meeting_id FOR UPDATE;

    IF (
        SELECT count(*) FROM public.meeting_photos
        WHERE meeting_id = NEW.meeting_id
    ) >= 50 THEN
        RAISE EXCEPTION 'meeting % already has the maximum of 50 photos', NEW.meeting_id
            USING ERRCODE = 'P0050';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meeting_photos_limit ON public.meeting_photos;
CREATE TRIGGER meeting_photos_limit
    BEFORE INSERT ON public.meeting_photos
    FOR EACH ROW EXECUTE FUNCTION public.enforce_meeting_photos_limit();
