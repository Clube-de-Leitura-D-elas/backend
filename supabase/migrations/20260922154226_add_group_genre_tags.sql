CREATE TABLE public.genres (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name varchar NOT NULL UNIQUE,
    CONSTRAINT genres_pkey PRIMARY KEY (id)
);

CREATE TABLE public.group_genres (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL,
    genre_id uuid NOT NULL,
    CONSTRAINT group_genres_pkey PRIMARY KEY (id),
    CONSTRAINT group_genres_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id),
    CONSTRAINT group_genres_genre_id_fkey FOREIGN KEY (genre_id) REFERENCES public.genres(id),
    CONSTRAINT group_genres_group_genre_unique UNIQUE (group_id, genre_id)
);