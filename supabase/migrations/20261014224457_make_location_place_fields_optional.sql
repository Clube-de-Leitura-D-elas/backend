-- O app ainda não usa o Google Places: o local do encontro é digitado como
-- texto livre (CLU-198). Endereço, place id e coordenadas passam a ser
-- opcionais até a busca de locais existir.
ALTER TABLE public.locations
ALTER COLUMN address DROP NOT NULL,
ALTER COLUMN google_place_id DROP NOT NULL,
ALTER COLUMN latitude DROP NOT NULL,
ALTER COLUMN longitude DROP NOT NULL;