-- =========================================================
-- 1. TYPES
-- =========================================================

DO $$ BEGIN
    CREATE TYPE public.app_roles AS ENUM (
    'READER',
    'MANAGER',
    'FOUNDER'
);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.levels_of_education AS ENUM (
    'NO_FORMAL_EDUCATION',
    'INCOMPLETE_ELEMENTARY',
    'ELEMENTARY',
    'INCOMPLETE_HIGH_SCHOOL',
    'HIGH_SCHOOL',
    'INCOMPLETE_TECHNICAL',
    'TECHNICAL',
    'INCOMPLETE_UNDERGRADUATE',
    'UNDERGRADUATE',
    'INCOMPLETE_POSTGRADUATE',
    'POSTGRADUATE',
    'INCOMPLETE_MASTERS',
    'MASTERS',
    'INCOMPLETE_DOCTORATE',
    'DOCTORATE',
    'POSTDOCTORATE'
);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.meeting_status AS ENUM (
    'CREATED',
    'SCHEDULED',
    'IN_PROGRESS',
    'CONCLUDED'
);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE public.notification_type AS ENUM (
    'BIRTHDAY',
    'BOOK_SUGGESTIONS_REMINDER',
    'COORDINATOR_TASKS_REMINDER',
    'HOST_TASKS_REMINDER'
);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- =========================================================
-- 2. TABLES WITHOUT DEPENDENCIES (or only on types)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.cities (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name varchar NOT NULL,
    uf varchar NOT NULL,
    CONSTRAINT cities_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.photos (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    url varchar NOT NULL,
    file_extension varchar NOT NULL,
    uploaded_at date NOT NULL,
    uploaded_by uuid NOT NULL,
    CONSTRAINT photos_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.locations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    address varchar NOT NULL,
    google_place_id varchar NOT NULL,
    name varchar NOT NULL,
    latitude varchar NOT NULL,
    longitude varchar NOT NULL,
    CONSTRAINT locations_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.notifications (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    title varchar NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    message varchar NOT NULL,
    type notification_type NOT NULL,
    CONSTRAINT notifications_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.pending_users (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    name varchar NOT NULL,
    email varchar NOT NULL,
    address varchar NOT NULL,
    phone_number varchar NOT NULL,
    is_approved boolean NOT NULL DEFAULT false,
    claim_token text,
    token_used_at timestamp with time zone DEFAULT now(),
    claim_token_expires_at timestamp with time zone,
    birthday date NOT NULL,
    job varchar,
    level_of_education varchar,
    instagram_user varchar,
    book_name varchar,
    CONSTRAINT pending_users_pkey PRIMARY KEY (id)
);

-- =========================================================
-- 3. TABLES DEPENDING ON THE ABOVE
-- =========================================================

-- depends on: cities
CREATE TABLE IF NOT EXISTS public.zones (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name varchar NOT NULL,
    city_id uuid NOT NULL,
    CONSTRAINT zones_pkey PRIMARY KEY (id),
    CONSTRAINT zones_city_id_fkey
        FOREIGN KEY (city_id) REFERENCES public.cities(id)
);

-- depends on: photos
CREATE TABLE IF NOT EXISTS public.books (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name varchar NOT NULL,
    author varchar NOT NULL,
    publisher varchar NOT NULL,
    genre varchar NOT NULL,
    external_id varchar NOT NULL,
    photo_id uuid,
    CONSTRAINT books_pkey PRIMARY KEY (id),
    CONSTRAINT books_photo_id_fkey
        FOREIGN KEY (photo_id) REFERENCES public.photos(id)
);

-- =========================================================
-- 4. TABLES DEPENDING ON cities/zones/photos/auth.users
-- =========================================================

-- depends on: photos, cities, zones, auth.users
CREATE TABLE IF NOT EXISTS public.users (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name varchar NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    phone varchar NOT NULL,
    instagram varchar,
    email varchar NOT NULL,
    birth_date date NOT NULL,
    job varchar,
    level_of_education levels_of_education,
    app_role app_roles NOT NULL DEFAULT 'READER',
    photo_id uuid,
    city_id uuid NOT NULL,
    zone_id uuid,
    is_active boolean NOT NULL DEFAULT true,
    user_id uuid NOT NULL UNIQUE,   
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_photo_id_fkey
        FOREIGN KEY (photo_id) REFERENCES public.photos(id),
    CONSTRAINT users_city_id_fkey
        FOREIGN KEY (city_id) REFERENCES public.cities(id),
    CONSTRAINT users_zone_id_fkey
        FOREIGN KEY (zone_id) REFERENCES public.zones(id),
    CONSTRAINT users_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES auth.users(id)
);

-- depends on: photos, cities, zones
CREATE TABLE IF NOT EXISTS public.groups (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    number integer NOT NULL,
    description varchar NOT NULL,
    photo_id uuid NOT NULL,
    city_id uuid NOT NULL,
    zone_id uuid,
    active boolean NOT NULL DEFAULT true,
    whatsapp_link varchar,
    CONSTRAINT groups_pkey PRIMARY KEY (id),
    CONSTRAINT groups_photo_id_fkey
        FOREIGN KEY (photo_id) REFERENCES public.photos(id),
    CONSTRAINT groups_city_id_fkey
        FOREIGN KEY (city_id) REFERENCES public.cities(id),
    CONSTRAINT groups_zone_id_fkey
        FOREIGN KEY (zone_id) REFERENCES public.zones(id)
);

-- =========================================================
-- 5. TABLES DEPENDING ON users/groups
-- =========================================================

-- depends on: groups, users
CREATE TABLE IF NOT EXISTS public.group_users (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    group_id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL DEFAULT gen_random_uuid(),
    is_coordinator boolean NOT NULL DEFAULT false,
    registration_status varchar NOT NULL,
    last_consecutive_absences smallint NOT NULL DEFAULT 0,
    CONSTRAINT group_users_pkey PRIMARY KEY (id),
    CONSTRAINT group_users_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES public.groups(id),
    CONSTRAINT group_users_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id)
);

-- =========================================================
-- 6. TABLES DEPENDING ON group_users/locations/groups/books
-- =========================================================

-- depends on: locations, groups, books, group_users
CREATE TABLE IF NOT EXISTS public.meetings (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    date timestamp with time zone,
    location_id uuid,
    group_id uuid NOT NULL,
    host_id uuid NOT NULL,
    book_id uuid NOT NULL,
    status meeting_status NOT NULL DEFAULT 'CREATED',
    CONSTRAINT meetings_pkey PRIMARY KEY (id),
    CONSTRAINT meetings_location_id_fkey
        FOREIGN KEY (location_id) REFERENCES public.locations(id),
    CONSTRAINT meetings_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES public.groups(id),
    CONSTRAINT meetings_book_id_fkey
        FOREIGN KEY (book_id) REFERENCES public.books(id),
    CONSTRAINT meetings_host_id_fkey
        FOREIGN KEY (host_id) REFERENCES public.group_users(id)
);

-- depends on: books, group_users
CREATE TABLE IF NOT EXISTS public.book_suggestions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    book_id uuid NOT NULL,
    group_user_id uuid NOT NULL,
    suggested_at timestamp with time zone NOT NULL,
    book_status varchar NOT NULL,
    CONSTRAINT book_suggestions_pkey PRIMARY KEY (id),
    CONSTRAINT book_suggestions_group_user_id_fkey
        FOREIGN KEY (group_user_id) REFERENCES public.group_users(id),
    CONSTRAINT book_suggestions_book_id_fkey
        FOREIGN KEY (book_id) REFERENCES public.books(id)
);

-- =========================================================
-- 7. TABLES DEPENDING ON meetings
-- =========================================================

-- depends on: group_users, meetings
CREATE TABLE IF NOT EXISTS public.meeting_group_users (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    group_user_id uuid NOT NULL,
    meeting_id uuid NOT NULL,
    presence_status varchar NOT NULL,
    CONSTRAINT meeting_group_users_pkey PRIMARY KEY (id),
    CONSTRAINT meeting_group_users_group_user_id_fkey
        FOREIGN KEY (group_user_id) REFERENCES public.group_users(id),
    CONSTRAINT meeting_group_users_meeting_id_fkey
        FOREIGN KEY (meeting_id) REFERENCES public.meetings(id)
);

-- depends on: photos, meetings
CREATE TABLE IF NOT EXISTS public.meeting_photos (
    photo_id uuid NOT NULL,
    meeting_id uuid NOT NULL,
    is_cover boolean NOT NULL DEFAULT false,
    CONSTRAINT meeting_photos_pkey PRIMARY KEY (photo_id),
    CONSTRAINT meeting_photos_photo_id_fkey
        FOREIGN KEY (photo_id) REFERENCES public.photos(id),
    CONSTRAINT meeting_photos_meeting_id_fkey
        FOREIGN KEY (meeting_id) REFERENCES public.meetings(id)
);

-- depends on: meetings, users
CREATE TABLE IF NOT EXISTS public.meeting_guests (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    meeting_id uuid NOT NULL,
    user_id uuid NOT NULL,
    CONSTRAINT meeting_guests_pkey PRIMARY KEY (id),
    CONSTRAINT meeting_guests_meeting_id_fkey
        FOREIGN KEY (meeting_id) REFERENCES public.meetings(id),
    CONSTRAINT meeting_guests_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id)
);

-- depends on: meetings, users, books
CREATE TABLE IF NOT EXISTS public.book_reviews (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    meeting_id uuid,
    user_id uuid NOT NULL,
    book_rating real NOT NULL,
    book_review varchar,
    evaluated_at timestamp with time zone NOT NULL
        DEFAULT (now() AT TIME ZONE 'utc'),
    book_id uuid NOT NULL,
    CONSTRAINT book_reviews_pkey PRIMARY KEY (id),
    CONSTRAINT meeting_book_reviews_meeting_id_fkey
        FOREIGN KEY (meeting_id) REFERENCES public.meetings(id),
    CONSTRAINT meeting_book_reviews_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id),
    CONSTRAINT book_reviews_book_id_fkey
        FOREIGN KEY (book_id) REFERENCES public.books(id)
);

-- depends on: notifications, users, meetings, groups
CREATE TABLE IF NOT EXISTS public.notifications_targets (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    notification_id uuid NOT NULL,
    user_id uuid NOT NULL,
    meeting_id uuid,
    group_id uuid,
    CONSTRAINT notifications_targets_pkey PRIMARY KEY (id),
    CONSTRAINT notifications_targets_meeting_id_fkey
        FOREIGN KEY (meeting_id) REFERENCES public.meetings(id),
    CONSTRAINT notifications_targets_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES public.groups(id),
    CONSTRAINT notifications_targets_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public.users(id),
    CONSTRAINT notifications_targets_notification_id_fkey
        FOREIGN KEY (notification_id) REFERENCES public.notifications(id)
);