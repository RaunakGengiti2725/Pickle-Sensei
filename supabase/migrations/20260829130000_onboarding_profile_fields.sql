-- Onboarding coaching-profile fields (PUT /v1/me/onboarding contract):
-- the user's own statements from onboarding, stored verbatim.
alter table public.profiles
  add column if not exists primary_goal text,
  add column if not exists biggest_problem text;
