-- =====================================================================
-- Rotina · solicitações de teste (bloco opcional do analista)
--
-- O analista pode, a qualquer momento e sem obrigação, pedir um teste para
-- uma referência: o que testar, por quê, início e data final prevista.
-- O gestor aprova ou reprova (reprovação exige justificativa). O analista
-- vê a decisão e pode corrigir e reenviar uma solicitação reprovada.
-- Escrita só pelas funções abaixo; leitura: o próprio analista ou o gestor.
-- =====================================================================

create table public.test_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id),
  sku            text not null check (length(btrim(sku)) > 0),
  analysis       text not null check (length(btrim(analysis)) > 0),     -- o que deve ser testado
  explanation    text not null check (length(btrim(explanation)) > 0),  -- por quê
  start_date     date not null,
  end_date       date not null,
  status         text not null default 'pendente' check (status in ('pendente', 'aprovada', 'reprovada')),
  review_reason  text,
  reviewed_by    uuid references public.profiles (id),
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_date >= start_date),
  check (status <> 'reprovada' or coalesce(length(btrim(review_reason)), 0) > 0)
);
create index test_requests_user on public.test_requests (user_id, created_at desc);
create index test_requests_status on public.test_requests (status);

alter table public.test_requests enable row level security;
create policy test_requests_select on public.test_requests for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.is_active_user()));
revoke all on public.test_requests from anon;
revoke insert, update, delete on public.test_requests from authenticated;

create trigger test_requests_touch before update on public.test_requests
  for each row execute function public.touch_updated_at();
create trigger a_audit after insert or update on public.test_requests
  for each row execute function public.audit_trigger();

create or replace function public.validate_test_request(p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns void language plpgsql immutable as $$
begin
  if coalesce(btrim(p_sku), '') = '' then raise exception 'Informe a referência.' using errcode = '22023'; end if;
  if coalesce(btrim(p_analysis), '') = '' then raise exception 'Descreva o que deve ser testado.' using errcode = '22023'; end if;
  if coalesce(btrim(p_explanation), '') = '' then raise exception 'Explique por que fazer este teste.' using errcode = '22023'; end if;
  if p_start is null or p_end is null then raise exception 'Informe o início e a data final prevista.' using errcode = '22023'; end if;
  if p_end < p_start then raise exception 'A data final precisa ser igual ou depois do início.' using errcode = '22023'; end if;
end $$;

-- Analista: nova solicitação
create or replace function public.create_test_request(p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  if not is_active_user() then raise exception 'Usuário inativo.' using errcode = '42501'; end if;
  perform validate_test_request(p_sku, p_analysis, p_explanation, p_start, p_end);
  perform set_config('app.audit_action', 'teste_solicitado', true);
  insert into test_requests (user_id, sku, analysis, explanation, start_date, end_date)
  values (auth.uid(), btrim(p_sku), btrim(p_analysis), btrim(p_explanation), p_start, p_end)
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Analista: corrige e reenvia uma solicitação reprovada
create or replace function public.resubmit_test_request(p_id uuid, p_sku text, p_analysis text, p_explanation text, p_start date, p_end date)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  select * into r from test_requests where id = p_id for update;
  if not found or r.user_id is distinct from auth.uid() then
    raise exception 'Solicitação não encontrada.' using errcode = 'P0002';
  end if;
  if r.status <> 'reprovada' then raise exception 'Só dá para reenviar uma solicitação reprovada.' using errcode = '22023'; end if;
  perform validate_test_request(p_sku, p_analysis, p_explanation, p_start, p_end);
  perform set_config('app.audit_action', 'teste_reenviado', true);
  update test_requests
     set sku = btrim(p_sku), analysis = btrim(p_analysis), explanation = btrim(p_explanation),
         start_date = p_start, end_date = p_end, status = 'pendente',
         review_reason = null, reviewed_by = null, reviewed_at = null
   where id = p_id
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

-- Gestor: aprova ou reprova (reprovar exige justificativa)
create or replace function public.review_test_request(p_id uuid, p_status text, p_reason text default null)
returns public.test_requests language plpgsql security definer set search_path = public as $$
declare r test_requests;
begin
  if not is_admin() then raise exception 'Apenas o gestor aprova ou reprova testes.' using errcode = '42501'; end if;
  if p_status not in ('aprovada', 'reprovada') then raise exception 'Escolha aprovar ou reprovar.' using errcode = '22023'; end if;
  if p_status = 'reprovada' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Informe a justificativa da reprovação, para o analista saber o motivo.' using errcode = '22023';
  end if;
  select * into r from test_requests where id = p_id for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  if r.status <> 'pendente' then raise exception 'Esta solicitação já foi avaliada.' using errcode = '22023'; end if;
  perform set_config('app.audit_action', case p_status when 'aprovada' then 'teste_aprovado' else 'teste_reprovado' end, true);
  update test_requests
     set status = p_status, review_reason = nullif(btrim(p_reason), ''), reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_id
  returning * into r;
  perform set_config('app.audit_action', '', true);
  return r;
end $$;

revoke execute on function public.validate_test_request(text, text, text, date, date),
  public.create_test_request(text, text, text, date, date),
  public.resubmit_test_request(uuid, text, text, text, date, date),
  public.review_test_request(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.create_test_request(text, text, text, date, date),
  public.resubmit_test_request(uuid, text, text, text, date, date),
  public.review_test_request(uuid, text, text)
  to authenticated;
