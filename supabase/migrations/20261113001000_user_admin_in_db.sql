-- =====================================================================
-- Rotina · usuários e papéis geridos direto no banco (sem Edge Function)
--
-- O papel de cada pessoa é a coluna public.profiles.role (tipo user_role:
-- 'analista' ou 'admin'). Pode ser alterado:
--   · no painel do admin master (Usuários e acessos), ou
--   · direto no banco (Table Editor > profiles > role / active).
-- Nos dois casos, o login (auth.users) acompanha automaticamente:
--   · role   → app_metadata.role
--   · active → bloqueia ou libera o login (banned_until), sem apagar histórico.
-- O admin master também cria logins e define senhas pelo painel.
-- Proteção: o último admin master ativo não pode ser rebaixado nem desativado.
-- =====================================================================

comment on type public.user_role is 'Papel do usuário: analista ou admin (admin master).';
comment on column public.profiles.role is 'Papel: analista ou admin. Pode ser editado aqui ou no painel; o login acompanha.';
comment on column public.profiles.active is 'false bloqueia o login sem apagar o histórico.';

-- ---------------------------------------------------------------------
-- Nunca ficar sem admin master
-- ---------------------------------------------------------------------
create or replace function public.guard_last_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active) then
    if not exists (select 1 from profiles where id <> old.id and role = 'admin' and active) then
      raise exception 'Este é o último admin master ativo. Promova outra pessoa a admin antes de rebaixar ou desativar esta.'
        using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

create trigger a_guard_last_admin before update of role, active on public.profiles
  for each row execute function public.guard_last_admin();

-- ---------------------------------------------------------------------
-- Papel e situação do perfil → login
-- ---------------------------------------------------------------------
create or replace function public.sync_profile_to_auth()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  if new.role is distinct from old.role or new.active is distinct from old.active then
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', new.role::text),
           banned_until = case when new.active then null else now() + interval '100 years' end,
           updated_at = now()
     where id = new.id;
  end if;
  return null;
end $$;

create trigger z_sync_profile_to_auth after update of role, active on public.profiles
  for each row execute function public.sync_profile_to_auth();

-- ---------------------------------------------------------------------
-- Admin cria login (e-mail confirmado, senha inicial definida por ele)
-- ---------------------------------------------------------------------
create or replace function public.admin_create_user(p_email text, p_full_name text, p_role public.user_role, p_password text)
returns public.profiles language plpgsql security definer set search_path = public, extensions, auth as $$
declare v_id uuid := gen_random_uuid(); v_email text := lower(btrim(p_email)); p profiles;
begin
  if not is_admin() then raise exception 'Apenas admin master cria usuários.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(btrim(p_full_name), '') = '' then raise exception 'Informe o nome.' using errcode = '22023'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa de pelo menos 8 caracteres.' using errcode = '22023'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'Já existe um login com este e-mail.' using errcode = '22023';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
          crypt(p_password, gen_salt('bf')), now(),
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', p_role::text),
          jsonb_build_object('full_name', btrim(p_full_name)), now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true), 'email', null, now(), now());

  -- O perfil nasce pelo gatilho on_auth_user_created; garante papel e nome.
  update profiles set role = p_role, full_name = btrim(p_full_name) where id = v_id returning * into p;
  perform generate_tasks(local_today(), week_end(local_today()));
  return p;
end $$;

-- ---------------------------------------------------------------------
-- Admin define uma nova senha para alguém (sem expor a senha na auditoria)
-- ---------------------------------------------------------------------
create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if not is_admin() then raise exception 'Apenas admin master redefine senhas.' using errcode = '42501'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa de pelo menos 8 caracteres.' using errcode = '22023'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user;
  if not found then raise exception 'Usuário não encontrado.' using errcode = 'P0002'; end if;
  insert into audit_log (actor_id, action, entity, entity_id) values (auth.uid(), 'senha_redefinida', 'profiles', p_user::text);
end $$;

revoke execute on function public.guard_last_admin(), public.sync_profile_to_auth(),
  public.admin_create_user(text, text, public.user_role, text), public.admin_set_password(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_create_user(text, text, public.user_role, text), public.admin_set_password(uuid, text)
  to authenticated;
