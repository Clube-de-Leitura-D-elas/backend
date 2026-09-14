// O projeto ainda não gera os tipos do banco (`supabase gen types typescript`).
// Sem eles, o supabase-js tipa todas as linhas como `never`; este alias deixa as
// consultas sem tipo até os tipos gerados serem adicionados aqui.
// deno-lint-ignore no-explicit-any
export type Database = any;
