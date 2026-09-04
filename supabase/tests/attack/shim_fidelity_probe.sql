-- Prints whether a function whose author revoked EXECUTE from PUBLIC only is
-- still executable by anon under the CURRENT default privileges. Run once
-- after shim_auth.sql (expected: f) and once after
-- shim_hosted_function_defaults.sql (expected: t, matching hosted Supabase).
-- The canary is dropped so no migration or matrix ever sees it.
create function public.__fidelity_canary() returns int language sql as $$ select 1 $$;
revoke execute on function public.__fidelity_canary() from public;
\t on
select 'shim_fidelity_probe: anon EXECUTE after revoke-from-public-only = '
       || has_function_privilege('anon', 'public.__fidelity_canary()', 'execute');
\t off
drop function public.__fidelity_canary();
