# Supabase Migrations

Migrations do banco de dados do Clube de Leitura D'Elas.

---

## 📁 Estrutura

```
migrations/
└── YYYYMMDDHHMMSS_nome_da_migration.sql
```

Cada arquivo representa uma alteração incremental no banco. O nome é gerado automaticamente pelo CLI do Supabase.

---

## 🚀 Como rodar

### Pré-requisitos

```bash
npm install --save-dev supabase
```

### Criar uma nova migration

```bash
npx supabase migration new nome_da_migration
```

### Aplicar migrations no banco remoto

```bash
npx supabase login
npx supabase link
npx supabase db push
```

---

## ✅ Checklist de RLS

Toda tabela criada deve passar por este checklist antes de ir para produção:

- [ ] RLS está **habilitado** na tabela (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`)
- [ ] Existe policy de **SELECT** — quem pode ler?
- [ ] Existe policy de **INSERT** — quem pode inserir?
- [ ] Existe policy de **UPDATE** — quem pode atualizar?
- [ ] Existe policy de **DELETE** — quem pode deletar?
- [ ] Usuário só acessa os **próprios dados** (`auth.uid() = user_id`)
- [ ] Nenhuma policy usa `USING (true)` sem justificativa documentada
- [ ] Policies foram testadas com um usuário autenticado e um não autenticado

---

## 📋 Tabelas

| Tabela | RLS | Descrição |
|--------|-----|-----------|
| `profiles` | ✅ | Perfil do usuário autenticado |
