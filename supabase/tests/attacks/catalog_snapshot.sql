-- ATTACK 01 — upgrade-history divergence.
--
-- A deterministic dump of everything that decides "who may do what" in the
-- public and api_private schemas: table / column / sequence / schema
-- privileges of the three client-facing roles, function EXECUTE, function
-- security properties (definer, search_path, volatility), RLS state and
-- policies, triggers, constraints, unique indexes, default ACLs. The harness
-- runs this after every migration history and diffs the outputs: a database
-- upgraded from any historical state must land on exactly the fresh-install
-- security state. Any line here that differs between histories is a real
-- divergence the runner's matrix cannot see (the matrix asserts specific
-- boundaries, not the whole state).
--
-- Output is one text column, ordered, so `diff` is meaningful.
\pset format unaligned
\pset tuples_only on

with roles(r) as (values ('anon'), ('authenticated'), ('service_role'), ('public')),
privs(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
rels as (
  select c.oid, n.nspname, c.relname, c.relkind
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'api_private') and c.relkind in ('r', 'v', 'm', 'p')
)
select format('TABLE_PRIV %s.%s %s %s %s', nspname, relname, r, p,
  has_table_privilege(r, oid, p))
from rels, roles, privs
order by 1;

with roles(r) as (values ('anon'), ('authenticated'), ('service_role'), ('public')),
privs(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')),
cols as (
  select c.oid, n.nspname, c.relname, a.attname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname in ('public', 'api_private') and c.relkind in ('r', 'v', 'm', 'p')
)
select format('COLUMN_PRIV %s.%s.%s %s %s %s', nspname, relname, attname, r, p,
  has_column_privilege(r, oid, attname, p))
from cols, roles, privs
order by 1;

with roles(r) as (values ('anon'), ('authenticated'), ('service_role'), ('public')),
privs(p) as (values ('USAGE'), ('SELECT'), ('UPDATE'))
select format('SEQUENCE_PRIV %s.%s %s %s %s', n.nspname, c.relname, r, p,
  has_sequence_privilege(r, c.oid, p))
from pg_class c join pg_namespace n on n.oid = c.relnamespace, roles, privs
where n.nspname in ('public', 'api_private') and c.relkind = 'S'
order by 1;

with roles(r) as (values ('anon'), ('authenticated'), ('service_role'), ('public')),
privs(p) as (values ('USAGE'), ('CREATE'))
select format('SCHEMA_PRIV %s %s %s %s', n.nspname, r, p, has_schema_privilege(r, n.oid, p))
from pg_namespace n, roles, privs
where n.nspname in ('public', 'api_private', 'auth', 'extensions')
order by 1;

with roles(r) as (values ('anon'), ('authenticated'), ('service_role'), ('public'))
select format('FUNCTION_EXEC %s.%s(%s) %s %s', n.nspname, p.proname,
  pg_get_function_identity_arguments(p.oid), r, has_function_privilege(r, p.oid, 'EXECUTE'))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace, roles
where n.nspname in ('public', 'api_private')
order by 1;

select format('FUNCTION_PROPS %s.%s(%s) definer=%s volatility=%s config=%s owner=%s returns=%s',
  n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
  p.prosecdef, p.provolatile, coalesce(array_to_string(p.proconfig, ';'), '-'),
  pg_get_userbyid(p.proowner), pg_get_function_result(p.oid))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'api_private')
order by 1;

select format('RLS %s.%s enabled=%s forced=%s owner=%s', n.nspname, c.relname,
  c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api_private') and c.relkind in ('r', 'p')
order by 1;

select format('VIEW %s.%s security_invoker=%s', n.nspname, c.relname,
  coalesce((select true from unnest(c.reloptions) o where o = 'security_invoker=true'), false))
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api_private') and c.relkind = 'v'
order by 1;

select format('POLICY %s.%s %s permissive=%s cmd=%s roles=%s using=%s check=%s',
  n.nspname, c.relname, pol.polname, pol.polpermissive, pol.polcmd,
  coalesce((select string_agg(pg_get_userbyid(x), ',' order by pg_get_userbyid(x))
           from unnest(pol.polroles) x), 'public'),
  coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-'),
  coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-'))
from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api_private')
order by 1;

select format('TRIGGER %s.%s %s enabled=%s def=%s', n.nspname, c.relname, t.tgname, t.tgenabled,
  pg_get_triggerdef(t.oid))
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api_private') and not t.tgisinternal
order by 1;

select format('CONSTRAINT %s.%s %s validated=%s def=%s', n.nspname, c.relname, con.conname,
  con.convalidated, pg_get_constraintdef(con.oid))
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api_private')
order by 1;

select format('INDEX %s.%s %s', n.nspname, c.relname, pg_get_indexdef(i.indexrelid))
from pg_index i
join pg_class c on c.oid = i.indrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'api_private')
order by 1;

select format('DEFAULT_ACL role=%s schema=%s objtype=%s acl=%s',
  pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '<global>'), d.defaclobjtype,
  (select string_agg(a::text, ',' order by a::text) from unnest(d.defaclacl) a))
from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
order by 1;

select format('ROLE %s super=%s bypassrls=%s login=%s inherit=%s', r.rolname, r.rolsuper,
  r.rolbypassrls, r.rolcanlogin, r.rolinherit)
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by 1;

select format('EXTENSION %s schema=%s', e.extname, n.nspname)
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
order by 1;
