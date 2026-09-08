-- ============================================================================
-- Settings: profile identity, notification preferences, device registry,
-- avatar storage, account deletion.
--
--   fitness_profiles  + display_name, username (unique, case-insensitive),
--                       avatar_url, updated_at
--   user_settings       one row per user: notification toggles
--   user_devices        devices that have opened the app with this account
--   storage.buckets     'avatars' (public read, owner write), guarded so the
--                       migration still applies on a plain Postgres
--   functions           username_available(), update_my_profile(),
--                       delete_my_account()
--
-- Every write path that touches another user's namespace (usernames) or
-- auth tables goes through a SECURITY DEFINER function; clients keep their
-- existing column-level UPDATE on strength_tier only.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ----------------------------------------------------------------------------
-- 1. Profile identity
-- ----------------------------------------------------------------------------

ALTER TABLE "fitness_profiles"
  ADD COLUMN "display_name" TEXT,
  ADD COLUMN "username" CITEXT,
  ADD COLUMN "avatar_url" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE "fitness_profiles"
  ADD CONSTRAINT "fitness_profiles_username_key" UNIQUE ("username"),
  ADD CONSTRAINT "fitness_profiles_username_format"
    CHECK ("username" IS NULL OR "username"::text ~ '^[a-z0-9][a-z0-9._]{2,19}$'),
  ADD CONSTRAINT "fitness_profiles_display_name_len"
    CHECK ("display_name" IS NULL OR length(btrim("display_name")) BETWEEN 1 AND 40);

-- Lower-cased, no leading '@', trimmed. The one normalisation every path uses.
CREATE OR REPLACE FUNCTION public.normalize_username(p_raw text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(coalesce(p_raw, '')), '^@+', ''))
$$;

-- Backfill usernames from the handle written at sign-up (auth user
-- metadata), falling back to the email's local part. Collisions get a
-- numeric suffix; anything too short becomes fighter<6 hex of the id>.
DO $$
DECLARE
  r RECORD;
  v_base text;
  v_candidate text;
  v_n integer;
BEGIN
  FOR r IN
    SELECT p."user_id", u.raw_user_meta_data->>'handle' AS handle, u.email
      FROM "fitness_profiles" p
      JOIN auth.users u ON u.id = p."user_id"
     WHERE p."username" IS NULL
     ORDER BY p."created_at"
  LOOP
    v_base := regexp_replace(
      public.normalize_username(coalesce(nullif(r.handle, ''), split_part(coalesce(r.email, ''), '@', 1))),
      '[^a-z0-9._]', '', 'g');
    v_base := regexp_replace(v_base, '^[._]+', '');
    IF length(v_base) < 3 THEN
      v_base := 'fighter' || substr(replace(r."user_id"::text, '-', ''), 1, 6);
    END IF;
    v_base := substr(v_base, 1, 20);
    v_candidate := v_base;
    v_n := 1;
    WHILE EXISTS (SELECT 1 FROM "fitness_profiles" WHERE "username" = v_candidate::citext) LOOP
      v_n := v_n + 1;
      v_candidate := substr(v_base, 1, 20 - length(v_n::text)) || v_n::text;
    END LOOP;
    UPDATE "fitness_profiles" SET "username" = v_candidate::citext WHERE "user_id" = r."user_id";
  END LOOP;
END $$;

-- "Is this name free for me?" Checks across every profile, which the caller's
-- own RLS (select-own) could not do.
CREATE OR REPLACE FUNCTION public.username_available(p_username text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := public.normalize_username(p_username);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;
  IF v_name !~ '^[a-z0-9][a-z0-9._]{2,19}$' THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM "fitness_profiles"
    WHERE "username" = v_name::citext AND "user_id" <> auth.uid()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.username_available(text) TO authenticated;

-- NULL leaves a field alone. '' clears display_name / avatar_url. A username,
-- once set, can only be changed, never cleared. Errors are stable codes the
-- app maps to copy: username_invalid, username_taken, display_name_invalid,
-- avatar_url_invalid.
CREATE OR REPLACE FUNCTION public.update_my_profile(
  p_display_name text DEFAULT NULL,
  p_username text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL
)
RETURNS "fitness_profiles"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_username text;
  v_row "fitness_profiles"%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  IF p_username IS NOT NULL THEN
    v_username := public.normalize_username(p_username);
    IF v_username !~ '^[a-z0-9][a-z0-9._]{2,19}$' THEN
      RAISE EXCEPTION 'username_invalid';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "fitness_profiles"
      WHERE "username" = v_username::citext AND "user_id" <> v_user
    ) THEN
      RAISE EXCEPTION 'username_taken';
    END IF;
  END IF;

  IF p_display_name IS NOT NULL AND btrim(p_display_name) <> ''
     AND length(btrim(p_display_name)) > 40 THEN
    RAISE EXCEPTION 'display_name_invalid';
  END IF;

  -- Only a file in this user's own folder of the avatars bucket may be
  -- recorded, so a profile can never point at someone else's picture or an
  -- arbitrary URL.
  IF p_avatar_url IS NOT NULL AND p_avatar_url <> ''
     AND p_avatar_url NOT LIKE '%/storage/v1/object/public/avatars/' || v_user::text || '/%' THEN
    RAISE EXCEPTION 'avatar_url_invalid';
  END IF;

  UPDATE "fitness_profiles"
     SET "display_name" = CASE
                            WHEN p_display_name IS NULL THEN "display_name"
                            WHEN btrim(p_display_name) = '' THEN NULL
                            ELSE btrim(p_display_name)
                          END,
         "username"     = CASE WHEN p_username IS NULL THEN "username" ELSE v_username::citext END,
         "avatar_url"   = CASE
                            WHEN p_avatar_url IS NULL THEN "avatar_url"
                            WHEN p_avatar_url = '' THEN NULL
                            ELSE p_avatar_url
                          END,
         "updated_at"   = now()
   WHERE "user_id" = v_user
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile not found';
  END IF;
  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    -- Two people took the same name in the same instant; the loser sees the
    -- same message as if it had been taken earlier.
    RAISE EXCEPTION 'username_taken';
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_my_profile(text, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. Notification preferences
-- ----------------------------------------------------------------------------

CREATE TABLE "user_settings" (
  "user_id"       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  "notifications" JSONB NOT NULL DEFAULT '{"callouts": true, "results": true, "reminders": true}'::jsonb,
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "user_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_settings_select_own" ON "user_settings"
  FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "user_settings_insert_own" ON "user_settings"
  FOR INSERT WITH CHECK ("user_id" = auth.uid());
CREATE POLICY "user_settings_update_own" ON "user_settings"
  FOR UPDATE USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());

-- ----------------------------------------------------------------------------
-- 3. Device registry
--
-- Supabase Auth has no client API that lists a user's sessions, so the app
-- records each device it is opened on and refreshes last_seen_at. "Sign out
-- other devices" pairs auth.signOut({scope: 'others'}) with deleting the
-- other rows.
-- ----------------------------------------------------------------------------

CREATE TABLE "user_devices" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "device_id"    TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "platform"     TEXT NOT NULL,
  "app_version"  TEXT,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "user_devices_user_id_device_id_key" UNIQUE ("user_id", "device_id")
);

CREATE INDEX "user_devices_user_id_idx" ON "user_devices" ("user_id");

ALTER TABLE "user_devices" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_devices_select_own" ON "user_devices"
  FOR SELECT USING ("user_id" = auth.uid());
CREATE POLICY "user_devices_insert_own" ON "user_devices"
  FOR INSERT WITH CHECK ("user_id" = auth.uid());
CREATE POLICY "user_devices_update_own" ON "user_devices"
  FOR UPDATE USING ("user_id" = auth.uid()) WITH CHECK ("user_id" = auth.uid());
CREATE POLICY "user_devices_delete_own" ON "user_devices"
  FOR DELETE USING ("user_id" = auth.uid());

-- ----------------------------------------------------------------------------
-- 4. Avatar storage (Supabase only; a plain Postgres has no storage schema)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    RAISE NOTICE 'storage schema not found - skipping avatars bucket (not a Supabase database?)';
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('avatars', 'avatars', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
  ON CONFLICT (id) DO NOTHING;

  -- Anyone can read (the URLs are shown to opponents later); only the owner
  -- can write, and only inside a folder named after their own user id.
  EXECUTE 'DROP POLICY IF EXISTS "avatars_public_read" ON storage.objects';
  EXECUTE $p$CREATE POLICY "avatars_public_read" ON storage.objects
    FOR SELECT USING (bucket_id = 'avatars')$p$;

  EXECUTE 'DROP POLICY IF EXISTS "avatars_owner_insert" ON storage.objects';
  EXECUTE $p$CREATE POLICY "avatars_owner_insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)$p$;

  EXECUTE 'DROP POLICY IF EXISTS "avatars_owner_update" ON storage.objects';
  EXECUTE $p$CREATE POLICY "avatars_owner_update" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)$p$;

  EXECUTE 'DROP POLICY IF EXISTS "avatars_owner_delete" ON storage.objects';
  EXECUTE $p$CREATE POLICY "avatars_owner_delete" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)$p$;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Account deletion
--
-- Bout history references users from both sides (challenges.created_by is
-- ON DELETE RESTRICT, matches.winner_id has no cascade), and an opponent's
-- record must survive this user leaving. So the account is erased and
-- locked rather than the auth row removed: profile identity, photo,
-- settings and devices go; the auth identity is anonymised, every session
-- revoked and the row banned so it can never sign in again. Refused while a
-- bout is live, because leaving mid-bout would strand the other fighter.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_live integer;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not signed in';
  END IF;

  -- An unanswered call-out has nothing staked yet; it can simply go.
  DELETE FROM "challenges" c
   WHERE c."created_by" = v_user
     AND c."status" = 'open'
     AND NOT EXISTS (SELECT 1 FROM "matches" m WHERE m."challenge_id" = c."id");

  SELECT count(*) INTO v_live
    FROM "challenges" c
   WHERE c."status" IN ('matched', 'in_progress', 'needs_review')
     AND (c."created_by" = v_user OR EXISTS (
           SELECT 1 FROM "matches" m
           JOIN "match_participants" p ON p."match_id" = m."id"
           WHERE m."challenge_id" = c."id" AND p."user_id" = v_user));
  IF v_live > 0 THEN
    RAISE EXCEPTION 'live_bouts';
  END IF;

  DELETE FROM "user_devices" WHERE "user_id" = v_user;
  DELETE FROM "user_settings" WHERE "user_id" = v_user;
  UPDATE "fitness_profiles"
     SET "display_name" = NULL, "username" = NULL, "avatar_url" = NULL, "updated_at" = now()
   WHERE "user_id" = v_user;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    DELETE FROM storage.objects
     WHERE bucket_id = 'avatars' AND (storage.foldername(name))[1] = v_user::text;
  END IF;

  DELETE FROM auth.mfa_factors WHERE user_id = v_user;
  DELETE FROM auth.identities WHERE user_id = v_user;
  DELETE FROM auth.refresh_tokens WHERE user_id = v_user::text;
  DELETE FROM auth.sessions WHERE user_id = v_user;
  UPDATE auth.users
     SET email = v_user::text || '@deleted.fittr.invalid',
         phone = NULL,
         raw_user_meta_data = jsonb_build_object('deleted', true),
         banned_until = 'infinity'::timestamptz,
         updated_at = now()
   WHERE id = v_user;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;

NOTIFY pgrst, 'reload schema';
