revoke all on function public.permit_backs_sync(text, text) from public, anon;
grant execute on function public.permit_backs_sync(text, text) to authenticated;

notify pgrst, 'reload schema';
