-- ============================================================================
-- Pickle Sensei — exit survey, question 2.
--
-- The survey became a two-question stepper: "What's making you leave?"
-- (reason) then "What would have kept you?" (wanted) + the optional comment.
-- Adds the second answer next to the first. 20260902000000 is already
-- applied remotely, hence a follow-up migration rather than an edit.
--
-- Vocabulary is enforced by the Edge Function (DELETION_SURVEY_WANTED,
-- mirroring apps/mobile/src/account/deletion.ts ACCOUNT_DELETION_WANTED);
-- the database bounds only the length. Nullable: skipping question 2 is
-- allowed and stores null. The client INSERT grant is table-level, so the
-- new column is writable through the same insert-only path; RLS unchanged.
-- ============================================================================

alter table public.account_deletion_feedback
  add column if not exists wanted text;

comment on column public.account_deletion_feedback.wanted is
  'Question 2 of the exit survey — what would have kept the player (accuracy | price | content | stability | switched | nothing); null when skipped.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'account_deletion_feedback_wanted_bounds'
  ) then
    alter table public.account_deletion_feedback
      add constraint account_deletion_feedback_wanted_bounds
      check (coalesce(length(wanted), 0) <= 50) not valid;
  end if;
end $$;
