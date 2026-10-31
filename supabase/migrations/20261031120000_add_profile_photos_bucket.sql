-- Fotos de perfil enviadas pelo app. Bucket privado: a leitura é feita só por
-- signed URL gerada nas edge functions, que usam a service role.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'profile-photos',
    'profile-photos',
    false,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;
