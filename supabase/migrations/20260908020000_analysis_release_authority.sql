-- W01/W04/W11: immutable release artifacts, independently approved outputs,
-- and a fail-closed operator switch. Deployment and runtime credentials cannot
-- approve scientific output. All mutation entry points are database-owner only.
begin;

create table api_private.analysis_release_policies (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  version text not null unique check (length(version) between 1 and 128),
  canonical_document text not null check (octet_length(canonical_document) <= 65536),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  installed_at timestamptz not null default now(),
  mechanics_approved_at timestamptz,
  benchmark_approved_at timestamptz,
  withdrawn_at timestamptz,
  check (encode(sha256(convert_to(canonical_document,'UTF8')),'hex') = sha256),
  check (canonical_document::jsonb = document),
  check (document ->> 'schemaVersion' is not distinct from 'analysis-release-policy-v1'),
  check (document ->> 'version' is not distinct from version)
);
create table api_private.analysis_release_control (
  singleton boolean primary key default true check (singleton),
  active_policy_sha256 text references api_private.analysis_release_policies(sha256),
  deny_new_authorizations boolean not null default true
);
insert into api_private.analysis_release_control(singleton) values (true);
create table api_private.analysis_release_decisions (
  id bigint generated always as identity primary key,
  policy_sha256 text references api_private.analysis_release_policies(sha256),
  action text not null check (action in ('approve_mechanics','approve_benchmark','activate','withdraw','deny_new')),
  actor text not null check (length(btrim(actor)) between 1 and 256),
  evidence_sha256 text check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz not null default now()
);
alter table api_private.analysis_release_policies enable row level security;
alter table api_private.analysis_release_control enable row level security;
alter table api_private.analysis_release_decisions enable row level security;
revoke all on api_private.analysis_release_policies, api_private.analysis_release_control,
  api_private.analysis_release_decisions from public, anon, authenticated, service_role;
revoke all on sequence api_private.analysis_release_decisions_id_seq from public, anon, authenticated, service_role;

create function api_private.guard_analysis_release_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_table_name = 'analysis_release_decisions' or tg_op = 'DELETE' then
    raise exception 'Release authority history is append-only' using errcode = 'check_violation';
  end if;
  if (new.sha256,new.version,new.canonical_document,new.document,new.installed_at)
       is distinct from (old.sha256,old.version,old.canonical_document,old.document,old.installed_at)
     or (old.mechanics_approved_at is not null and new.mechanics_approved_at is distinct from old.mechanics_approved_at)
     or (old.benchmark_approved_at is not null and new.benchmark_approved_at is distinct from old.benchmark_approved_at)
     or (old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at) then
    raise exception 'Installed release policy and prior decisions are immutable' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function api_private.guard_analysis_release_history() from public, anon, authenticated, service_role;
create trigger analysis_release_policy_immutable before update or delete on api_private.analysis_release_policies
  for each row execute function api_private.guard_analysis_release_history();
create trigger analysis_release_decisions_append_only before update or delete on api_private.analysis_release_decisions
  for each row execute function api_private.guard_analysis_release_history();

create function public.install_analysis_release_policy(p_canonical_document text, p_sha256 text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_document jsonb; v_version text;
begin
  if p_canonical_document is null or octet_length(p_canonical_document) > 65536
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or encode(sha256(convert_to(p_canonical_document,'UTF8')),'hex') <> p_sha256 then
    raise exception 'Release policy digest does not match the provided bytes' using errcode = 'check_violation';
  end if;
  v_document := p_canonical_document::jsonb;
  v_version := v_document ->> 'version';
  if jsonb_typeof(v_document) <> 'object'
     or v_document ->> 'schemaVersion' is distinct from 'analysis-release-policy-v1'
     or v_version is null or length(v_version) not between 1 and 128 or btrim(v_version) <> v_version
     or jsonb_typeof(v_document -> 'validFrom') is distinct from 'number'
     or jsonb_typeof(v_document -> 'validUntil') is distinct from 'number'
     or (v_document ->> 'validFrom')::numeric < 0
     or (v_document ->> 'validUntil')::numeric <= (v_document ->> 'validFrom')::numeric
     or (v_document ->> 'validUntil')::numeric > 253402300799
     or coalesce(v_document #>> '{mechanics,lineage,validationReport,sha256}','') !~ '^[0-9a-f]{64}$'
     or coalesce(v_document #>> '{benchmark,lineage,validationReport,sha256}','') !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid release policy artifact' using errcode = 'check_violation';
  end if;
  insert into api_private.analysis_release_policies(sha256,version,canonical_document,document)
    values (p_sha256,v_version,p_canonical_document,v_document)
    on conflict (sha256) do nothing;
end $$;

create function public.approve_analysis_release_output(p_sha256 text, p_output text, p_actor text, p_report_sha256 text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_policy api_private.analysis_release_policies%rowtype;
begin
  if p_output is null or p_output not in ('mechanics','benchmark') or p_actor is null or length(btrim(p_actor)) not between 1 and 256 then
    raise exception 'An explicit output and approver are required' using errcode = 'check_violation';
  end if;
  select * into v_policy from api_private.analysis_release_policies where sha256 = p_sha256 for update;
  if not found or v_policy.withdrawn_at is not null or p_report_sha256 is null
     or p_report_sha256 is distinct from (v_policy.document #>> array[p_output,'lineage','validationReport','sha256']) then
    raise exception 'Approval must identify an installed policy and its exact validation report' using errcode = 'check_violation';
  end if;
  if (p_output = 'mechanics' and v_policy.mechanics_approved_at is not null)
     or (p_output = 'benchmark' and v_policy.benchmark_approved_at is not null) then return; end if;
  if p_output = 'mechanics' then
    update api_private.analysis_release_policies set mechanics_approved_at = now() where sha256 = p_sha256;
  else
    update api_private.analysis_release_policies set benchmark_approved_at = now() where sha256 = p_sha256;
  end if;
  insert into api_private.analysis_release_decisions(policy_sha256,action,actor,evidence_sha256)
    values (p_sha256,'approve_' || p_output,btrim(p_actor),p_report_sha256);
end $$;

create function public.activate_analysis_release_policy(p_sha256 text, p_actor text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_policy api_private.analysis_release_policies%rowtype;
begin
  if p_actor is null or length(btrim(p_actor)) not between 1 and 256 then
    raise exception 'An explicit release operator is required' using errcode = 'check_violation';
  end if;
  perform 1 from api_private.analysis_release_control where singleton for update;
  select * into v_policy from api_private.analysis_release_policies where sha256 = p_sha256 for update;
  if not found or v_policy.mechanics_approved_at is null or v_policy.benchmark_approved_at is null
     or v_policy.withdrawn_at is not null
     or extract(epoch from now()) < (v_policy.document ->> 'validFrom')::numeric
     or extract(epoch from now()) >= (v_policy.document ->> 'validUntil')::numeric then
    raise exception 'Both outputs require current independent approval before activation' using errcode = 'check_violation';
  end if;
  update api_private.analysis_release_control set active_policy_sha256 = p_sha256, deny_new_authorizations = false where singleton;
  insert into api_private.analysis_release_decisions(policy_sha256,action,actor) values (p_sha256,'activate',btrim(p_actor));
end $$;

create function public.withdraw_analysis_release_policy(p_sha256 text, p_actor text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_policy api_private.analysis_release_policies%rowtype;
begin
  if p_actor is null or length(btrim(p_actor)) not between 1 and 256 then
    raise exception 'An explicit release operator is required' using errcode = 'check_violation';
  end if;
  perform 1 from api_private.analysis_release_control where singleton for update;
  select * into v_policy from api_private.analysis_release_policies where sha256 = p_sha256 for update;
  if not found then raise exception 'Unknown release policy' using errcode = 'check_violation'; end if;
  if v_policy.withdrawn_at is not null then return; end if;
  update api_private.analysis_release_policies set withdrawn_at = now() where sha256 = p_sha256;
  update api_private.analysis_release_control set deny_new_authorizations = true where singleton and active_policy_sha256 = p_sha256;
  insert into api_private.analysis_release_decisions(policy_sha256,action,actor) values (p_sha256,'withdraw',btrim(p_actor));
end $$;

create function public.deny_new_analysis_authorizations(p_actor text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_policy text;
begin
  if p_actor is null or length(btrim(p_actor)) not between 1 and 256 then
    raise exception 'An explicit release operator is required' using errcode = 'check_violation';
  end if;
  update api_private.analysis_release_control set deny_new_authorizations = true where singleton returning active_policy_sha256 into v_policy;
  insert into api_private.analysis_release_decisions(policy_sha256,action,actor) values (v_policy,'deny_new',btrim(p_actor));
end $$;

create function public.read_analysis_release_policy()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'document',p.document,'canonicalDocument',p.canonical_document,
    'denyNewAuthorizations',c.deny_new_authorizations,
    'approval',case when p.sha256 is null then null else jsonb_build_object(
      'policy',jsonb_build_object('version',p.version,'sha256',p.sha256),
      'mechanicsApprovedAt',floor(extract(epoch from p.mechanics_approved_at)),
      'benchmarkApprovedAt',floor(extract(epoch from p.benchmark_approved_at)),
      'withdrawnAt',floor(extract(epoch from p.withdrawn_at)),
      'denyNewAuthorizations',c.deny_new_authorizations) end)
    from api_private.analysis_release_control c
    left join api_private.analysis_release_policies p on p.sha256 = c.active_policy_sha256
    where c.singleton
$$;

revoke all on function public.install_analysis_release_policy(text,text),
  public.approve_analysis_release_output(text,text,text,text),
  public.activate_analysis_release_policy(text,text),
  public.withdraw_analysis_release_policy(text,text),
  public.deny_new_analysis_authorizations(text),
  public.read_analysis_release_policy() from public, anon, authenticated, service_role;
grant execute on function public.read_analysis_release_policy() to service_role;
notify pgrst, 'reload schema';
commit;
