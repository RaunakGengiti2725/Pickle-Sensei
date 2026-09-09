-- Normalized catalog snapshot (grants, column grants, function EXECUTE +
-- security mode, policies, RLS flags, triggers, constraints, indexes, column
-- definitions) for the migration-history convergence attack (adv11).
\pset tuples_only on
\pset format unaligned
select 'TBL '||x.t||' '||string_agg(x.priv, ',' order by x.priv) from (select n.nspname||'.'||c.relname||' '||r.rolname t, p.priv from pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
cross join lateral (select unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) priv) p
where n.nspname in ('public','api_private') and c.relkind in ('r','p','v') and has_table_privilege(r.rolname, c.oid, p.priv)) x
group by x.t order by 1;
select 'COL '||x.t||' '||string_agg(x.priv, ',' order by x.priv) from (select n.nspname||'.'||c.relname||'.'||a.attname||' '||r.rolname t, p.priv from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
cross join lateral (select unnest(array['INSERT','UPDATE','SELECT']) priv) p
where n.nspname in ('public','api_private') and c.relkind in ('r','p')
  and has_column_privilege(r.rolname, c.oid, a.attnum, p.priv) and not has_table_privilege(r.rolname, c.oid, p.priv)) x
group by x.t order by 1;
select 'FN '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||r.rolname||' '||case p.prosecdef when true then 'DEFINER' else 'INVOKER' end
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
where n.nspname in ('public','api_private') and has_function_privilege(r.rolname, p.oid, 'EXECUTE') order by 1;
select 'FNDEF '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||case p.prosecdef when true then 'DEFINER' else 'INVOKER' end||' '||coalesce(array_to_string(p.proconfig,';'),'')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','api_private') order by 1;
select 'POL '||c.relname||' '||p.polname||' '||p.polcmd::text||' '||case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end||' roles='||array_to_string(array(select rolname from pg_roles where oid = any(p.polroles) order by 1),',')||' using='||coalesce(pg_get_expr(p.polqual,c.oid),'')||' check='||coalesce(pg_get_expr(p.polwithcheck,c.oid),'')
from pg_policy p join pg_class c on c.oid=p.polrelid order by 1;
select 'RLS '||n.nspname||'.'||c.relname||' enabled='||c.relrowsecurity||' forced='||c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','api_private','auth') and c.relkind='r' order by 1;
select 'TRG '||c.relname||' '||t.tgname||' '||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in ('public','api_private','auth') order by 1;
select 'CON '||c.relname||' '||k.conname||' '||pg_get_constraintdef(k.oid)||' valid='||k.convalidated from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','api_private') order by 1;
select 'IDX '||pg_get_indexdef(i.indexrelid) from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','api_private') order by 1;
select 'COLDEF '||n.nspname||'.'||c.relname||'.'||a.attname||' '||format_type(a.atttypid,a.atttypmod)||' notnull='||a.attnotnull||' default='||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
where n.nspname in ('public','api_private') and c.relkind='r' order by 1;
