-- xc-i18n-unicode-names-text — PostgreSQL text-size semantics probe.
--
-- Runs against a throwaway Postgres that already has supabase/tests/shim_auth.sql
-- and every migration applied (scripts/xc-i18n/run_pg_probe.sh does that).
-- Every section prints one JSON document on its own line so the runner can
-- capture them verbatim as evidence. Expected-error cases go through xc_try()
-- so the SQLSTATE and message are recorded instead of aborting the run; only
-- a probe-harness bug aborts (ON_ERROR_STOP).
--
-- Measurement legend (all on the same text value):
--   length()/char_length()  = code points (server_encoding UTF8)
--   octet_length()          = UTF-8 bytes
--   pg_column_size()        = on-disk bytes incl. varlena header
--   normalize(x, NFC)       = canonical composition (graphemes are NOT a
--                             Postgres concept; the harness computes them
--                             client-side with Intl.Segmenter)
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create or replace function pg_temp.xc_try(stmt text) returns jsonb
language plpgsql as $$
begin
  execute stmt;
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'sqlstate', SQLSTATE, 'message', SQLERRM);
end $$;

-- Reads that must observe the xc_try() side effects to their left: a bare
-- uncorrelated subselect would be hoisted into an InitPlan and run first.
create or replace function pg_temp.xc_get(stmt text) returns jsonb
language plpgsql as $$
declare result jsonb;
begin
  execute 'select to_jsonb((' || stmt || '))' into result;
  return result;
exception when others then
  return jsonb_build_object('ok', false, 'sqlstate', SQLSTATE, 'message', SQLERRM);
end $$;

create temp table xc_corpus (name text, value text);
insert into xc_corpus values
  ('ascii', 'Alice'),
  ('latin_nfd', E'Zoe\u0308 Mu\u0308ller'),
  ('latin_nfc', 'Zoë Müller'),
  ('vietnamese', E'Nguy\u1ec5n Th\u1ecb H\u1ecda'),
  ('hebrew_rtl', E'\u05d3\u05d5\u05d3'),
  ('arabic_harakat', E'\u0645\u064f\u062d\u064e\u0645\u0651\u064e\u062f'),
  ('persian_zwnj', E'\u0639\u0644\u064a\u200c\u0631\u0636\u0627'),
  ('urdu', E'\u0645\u062d\u0645\u062f \u0639\u0644\u06cc'),
  ('mixed_bidi', E'Sam \u05e9\u05dc\u05d5\u05dd'),
  ('bidi_override', E'\u202eecilA'),
  ('devanagari_zwj', E'\u0915\u094d\u200d\u0937'),
  ('bengali', E'\u09b8\u09cc\u09b0\u09ad'),
  ('tamil', E'\u0b95\u0bcb\u0baa\u0bbe\u0bb2'),
  ('thai', E'\u0e2a\u0e21\u0e0a\u0e32\u0e22'),
  ('korean_nfc', E'\uae40\ubbfc\uc218'),
  ('korean_nfd', E'\u1100\u1175\u11b7\u1106\u1175\u11ab\u1109\u116e'),
  ('japanese', E'\u5c71\u7530\u592a\u90ce'),
  ('cjk_ext_b', E'\U00020000\U00020001'),
  ('emoji_3', E'\U0001f3d3\U0001f525\U0001f4aa'),
  ('family_zwj_1_grapheme', E'\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466'),
  ('three_tag_flags_3_graphemes', repeat(E'\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f', 3)),
  ('zalgo', E'A\u0300\u0301\u0302\u0303\u0304\u0305l\u0306\u0307i\u0308\u0309c\u030a\u030be'),
  ('zwsp_inside', E'Al\u200bice'),
  ('bom_prefix', E'\ufeffAlice'),
  ('c1_controls', E'Al\u0085\u009fice'),
  ('word_joiner_only', E'\u2060'),
  ('hangul_filler_only', E'\u3164'),
  ('nbsp_only', E'\u00a0\u00a0'),
  ('a39_plus_e_acute_nfd_40_graphemes', repeat('a', 39) || E'e\u0301'),
  ('emoji_x40_40_graphemes_80_utf16', repeat(E'\U0001f3d3', 40)),
  ('emoji_x41', repeat(E'\U0001f3d3', 41)),
  ('cjk_x80', repeat(E'\u4e2d', 80)),
  ('cjk_x81', repeat(E'\u4e2d', 81)),
  ('kb64_ascii', repeat('x', 65536)),
  ('kb64_emoji_16384_cp', repeat(E'\U0001f3d3', 16384)),
  ('kb64_plus_1_ascii', repeat('x', 65537));

-- ── 1. measurement matrix ────────────────────────────────────────────────────
select json_build_object(
  'section', 'measurements',
  'server_encoding', current_setting('server_encoding'),
  'pg_version', version(),
  'rows', json_agg(json_build_object(
    'name', name,
    'length_cp', length(value),
    'char_length_cp', char_length(value),
    'octet_length_bytes', octet_length(value),
    'pg_column_size_bytes', pg_column_size(value),
    'nfc_length_cp', length(normalize(value, NFC)),
    'is_nfc', value is NFC normalized,
    'value_json', case when length(value) <= 64 then to_json(value)::text else null end,
    'passes_profiles_first_name_char_length_80', char_length(value) <= 80,
    'passes_profiles_display_name_length_200', length(value) <= 200,
    'passes_consent_version_length_50', length(value) <= 50,
    'passes_deletion_details_length_1000', length(value) <= 1000,
    'passes_shots_shot_type_length_64', length(value) <= 64
  ) order by name))
from xc_corpus;

-- ── 2. NUL / lone surrogate / invalid UTF-8 at the SQL boundary ──────────────
select json_build_object(
  'section', 'nul_and_surrogates',
  'text_chr0', pg_temp.xc_try($q$ select chr(0) $q$),
  'text_e_u0000', pg_temp.xc_try($q$ select E'a\u0000b'::text $q$),
  'jsonb_escaped_nul', pg_temp.xc_try($q$ select '{"firstName":"Al\u0000ice"}'::jsonb $q$),
  'json_escaped_nul_untyped', pg_temp.xc_try($q$ select '{"firstName":"Al\u0000ice"}'::json $q$),
  'json_escaped_nul_extract_text', pg_temp.xc_try($q$ select ('{"firstName":"Al\u0000ice"}'::json) ->> 'firstName' $q$),
  'jsonb_lone_high_surrogate', pg_temp.xc_try($q$ select '{"firstName":"Al\ud800ice"}'::jsonb $q$),
  'jsonb_lone_low_surrogate', pg_temp.xc_try($q$ select '{"firstName":"Al\udc00ice"}'::jsonb $q$),
  'jsonb_valid_pair_becomes_astral', (select ('{"n":"\ud83c\udfd3"}'::jsonb ->> 'n') = E'\U0001f3d3'),
  'jsonb_zwj_family_preserved', (select length('{"n":"\ud83d\udc68\u200d\ud83d\udc69"}'::jsonb ->> 'n')),
  'invalid_utf8_bytes', pg_temp.xc_try($q$ select convert_from('\xc3'::bytea, 'UTF8') $q$),
  'overlong_utf8', pg_temp.xc_try($q$ select convert_from('\xc0af'::bytea, 'UTF8') $q$),
  'utf16_surrogate_encoded_as_utf8', pg_temp.xc_try($q$ select convert_from('\xeda080'::bytea, 'UTF8') $q$)
);

-- ── 3. apply_synced_shot(jsonb) is unreachable for NUL / lone surrogates ────
-- The edge forwards shotType / phase keys / version strings to this RPC after
-- a UTF-16 .length check only (no sanitizeUserText). PostgREST hands the JSON
-- body to Postgres as jsonb, so the cast below is exactly where such a shot
-- dies — before the function body runs.
select json_build_object(
  'section', 'apply_synced_shot_jsonb_boundary',
  'nul_in_shot_type', pg_temp.xc_try($q$ select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e9","shotType":"dr\u0000ive"}'::jsonb) $q$),
  'lone_surrogate_in_app_version', pg_temp.xc_try($q$ select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e9","versionVector":{"appVersion":"1.0\ud800"}}'::jsonb) $q$),
  'zwj_family_shot_type_reaches_function', pg_temp.xc_try($q$ select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e9","shotType":"\ud83d\udc68\u200d\ud83d\udc69"}'::jsonb) $q$)
);

-- ── 4. constraints actually enforce (NOT VALID only skips existing rows) ─────
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-0000000000aa', 'xc@example.com',
        '{"full_name":"\u05d3\u05d5\u05d3"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-xc', '00000000-0000-4000-8000-0000000000aa',
        '{"sub":"apple-sub-xc","email":"xc@example.com"}');

-- As the table owner (no RLS / column grants in the way): the CHECK itself.
select json_build_object(
  'section', 'profiles_constraints_as_owner',
  'display_name_from_hebrew_full_name', pg_temp.xc_get($q$ select display_name from public.profiles where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_display_name_200cp', pg_temp.xc_try($q$ update public.profiles set display_name = repeat(E'\u4e2d', 200) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_display_name_201cp', pg_temp.xc_try($q$ update public.profiles set display_name = repeat(E'\u4e2d', 201) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_display_name_200_emoji_800_bytes', pg_temp.xc_try($q$ update public.profiles set display_name = repeat(E'\U0001f3d3', 200) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'restore_display_name', pg_temp.xc_try($q$ update public.profiles set display_name = E'\u05d3\u05d5\u05d3' where id = '00000000-0000-4000-8000-0000000000aa' $q$)
);

-- As the edge function's client role (RLS + column grants, exactly what the
-- PostgREST update from /v1/me/onboarding runs as).
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';

select json_build_object(
  'section', 'profiles_first_name_as_authenticated',
  'update_cjk_x80_80cp', pg_temp.xc_try($q$ update public.profiles set first_name = repeat(E'\u4e2d', 80) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_cjk_x81_81cp', pg_temp.xc_try($q$ update public.profiles set first_name = repeat(E'\u4e2d', 81) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_emoji_x80_80cp_160utf16_320bytes', pg_temp.xc_try($q$ update public.profiles set first_name = repeat(E'\U0001f3d3', 80) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_zalgo_40_graphemes_120cp', pg_temp.xc_try($q$ update public.profiles set first_name = repeat(E'a\u0301\u0302', 40) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_three_tag_flags_3_graphemes_21cp', pg_temp.xc_try($q$ update public.profiles set first_name = repeat(E'\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f', 3) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_bidi_override_stored_verbatim', pg_temp.xc_try($q$ update public.profiles set first_name = E'\u202eecilA' where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'stored_after_bidi_update', pg_temp.xc_get($q$ select first_name from public.profiles where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'stored_after_bidi_update_cp', pg_temp.xc_get($q$ select length(first_name) from public.profiles where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_kb64', pg_temp.xc_try($q$ update public.profiles set first_name = repeat('x', 65536) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_display_name_as_authenticated_column_grant', pg_temp.xc_try($q$ update public.profiles set display_name = repeat(E'\u4e2d', 201) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_biggest_problem_500cp_ok', pg_temp.xc_try($q$ update public.profiles set biggest_problem = repeat(E'\U0001f3d3', 500) where id = '00000000-0000-4000-8000-0000000000aa' $q$),
  'update_biggest_problem_501cp', pg_temp.xc_try($q$ update public.profiles set biggest_problem = repeat(E'\U0001f3d3', 501) where id = '00000000-0000-4000-8000-0000000000aa' $q$)
);

-- Edge cap for consent_version / capture_mode is sanitizeUserText(x, 64)
-- code points (supabase/functions/api/index.ts:1428,1433); the DB constraint
-- is length() <= 50 (migration 20260831160000 lines 225-227). Values with
-- 51..64 code points pass the edge and are refused here.
select json_build_object(
  'section', 'consent_records_caps',
  'consent_version_50cp', pg_temp.xc_try($q$ insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode) values ('00000000-0000-4000-8000-0000000000aa', 'video_analysis', repeat(E'\u4e2d', 50), 'grant', 'onboarding', to_jsonb('iPhone'::text), 'all_captures') $q$),
  'consent_version_51cp_passes_edge_cap_64', pg_temp.xc_try($q$ insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode) values ('00000000-0000-4000-8000-0000000000aa', 'video_analysis', repeat(E'\u4e2d', 51), 'grant', 'onboarding', to_jsonb('iPhone'::text), 'all_captures') $q$),
  'consent_version_64cp_edge_max', pg_temp.xc_try($q$ insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode) values ('00000000-0000-4000-8000-0000000000aa', 'video_analysis', repeat(E'\U0001f3d3', 64), 'grant', 'onboarding', to_jsonb('iPhone'::text), 'all_captures') $q$),
  'capture_mode_51cp_passes_edge_cap_64', pg_temp.xc_try($q$ insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode) values ('00000000-0000-4000-8000-0000000000aa', 'video_analysis', 'v1', 'grant', 'onboarding', to_jsonb('iPhone'::text), repeat('m', 51)) $q$),
  'device_512_emoji_2048_bytes_under_4096', pg_temp.xc_try($q$ insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode) values ('00000000-0000-4000-8000-0000000000aa', 'video_analysis', 'v1', 'grant', 'onboarding', to_jsonb(repeat(E'\U0001f3d3', 512)), 'all_captures') $q$),
  'device_511cp_flags_2044_bytes', pg_temp.xc_try($q$ insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode) values ('00000000-0000-4000-8000-0000000000aa', 'video_analysis', 'v1', 'grant', 'onboarding', to_jsonb(repeat(E'\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f', 73)), 'all_captures') $q$),
  'device_sizes', (select json_build_object('emoji512_text_bytes', octet_length(repeat(E'\U0001f3d3', 512)), 'emoji512_jsonb_pg_column_size', pg_column_size(to_jsonb(repeat(E'\U0001f3d3', 512))), 'flags73_cp', length(repeat(E'\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f', 73)), 'flags73_text_bytes', octet_length(repeat(E'\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f', 73)), 'flags73_jsonb_pg_column_size', pg_column_size(to_jsonb(repeat(E'\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f', 73)))))
);

select json_build_object(
  'section', 'account_deletion_feedback_details',
  'details_500cp_emoji_edge_max', pg_temp.xc_try($q$ insert into public.account_deletion_feedback (user_id, reason, details, provider, platform, app_version) values ('00000000-0000-4000-8000-0000000000aa', 'other', repeat(E'\U0001f3d3', 500), 'apple', 'ios', '1.0') $q$),
  'details_1000cp_ok', pg_temp.xc_try($q$ insert into public.account_deletion_feedback (user_id, reason, details, provider, platform, app_version) values ('00000000-0000-4000-8000-0000000000aa', 'other', repeat(E'\u4e2d', 1000), 'apple', 'ios', '1.0') $q$),
  'details_1001cp', pg_temp.xc_try($q$ insert into public.account_deletion_feedback (user_id, reason, details, provider, platform, app_version) values ('00000000-0000-4000-8000-0000000000aa', 'other', repeat(E'\u4e2d', 1001), 'apple', 'ios', '1.0') $q$),
  'details_rtl_mixed_stored_verbatim', pg_temp.xc_try($q$ insert into public.account_deletion_feedback (user_id, reason, details, provider, platform, app_version) values ('00000000-0000-4000-8000-0000000000aa', 'other', E'Sam \u05e9\u05dc\u05d5\u05dd \u0639\u0644\u064a\u200c\u0631\u0636\u0627', 'apple', 'ios', '1.0') $q$),
  'select_as_authenticated_is_denied_append_only', pg_temp.xc_get($q$ select json_agg(details) from public.account_deletion_feedback where user_id = '00000000-0000-4000-8000-0000000000aa' and details like 'Sam %' $q$)
);

reset role;

select json_build_object(
  'section', 'account_deletion_feedback_stored_as_owner',
  'stored_rtl_details', pg_temp.xc_get($q$ select json_agg(details) from public.account_deletion_feedback where user_id = '00000000-0000-4000-8000-0000000000aa' and details like 'Sam %' $q$),
  'stored_rtl_details_cp', pg_temp.xc_get($q$ select json_agg(length(details)) from public.account_deletion_feedback where user_id = '00000000-0000-4000-8000-0000000000aa' and details like 'Sam %' $q$),
  'zwnj_preserved_in_details', pg_temp.xc_get($q$ select bool_and(position(E'\u200c' in details) > 0) from public.account_deletion_feedback where user_id = '00000000-0000-4000-8000-0000000000aa' and details like 'Sam %' $q$)
);
