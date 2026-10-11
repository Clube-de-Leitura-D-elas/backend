ALTER TABLE public.meeting_photos
ADD COLUMN is_sketch boolean NOT NULL DEFAULT true,
ADD COLUMN description varchar;