-- Scoped provisioning of the existing miner-behavior summary on official testnet.
-- No raw chain rows, source-table privileges, default ACLs or other summaries change.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
DO $$ BEGIN
  IF current_database() <> 'zcash_explorer_testnet'
     OR pg_is_in_recovery()
     OR (SELECT hash FROM public.blocks WHERE height=0) IS DISTINCT FROM
        '05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38' THEN
    RAISE EXCEPTION 'Official testnet primary database required';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.mining_behavior_daily (
    date date NOT NULL,
    pool_name text NOT NULL,
    miner_address text NOT NULL,
    earned_zat bigint NOT NULL DEFAULT 0,
    spent_zat bigint NOT NULL DEFAULT 0,
    held_zat bigint NOT NULL DEFAULT 0,
    blocks_mined integer NOT NULL DEFAULT 0,
    outputs_spent integer NOT NULL DEFAULT 0,
    outputs_total integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (date, pool_name)
);
DO $$
DECLARE r record;
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid='public.mining_behavior_daily'::regclass) <> current_user::regrole THEN
    RAISE EXCEPTION 'Summary owner requires review';
  END IF;
  -- Remove any rights supplied by default ACLs, including future table rights.
  FOR r IN
    SELECT DISTINCT a.grantee, bool_or(a.privilege_type='SELECT') OVER (PARTITION BY a.grantee) AS can_select
    FROM pg_class t CROSS JOIN LATERAL aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) a
    WHERE t.oid='public.mining_behavior_daily'::regclass AND a.grantee<>t.relowner
  LOOP
    IF r.grantee=0 THEN
      REVOKE ALL PRIVILEGES ON public.mining_behavior_daily FROM PUBLIC CASCADE;
    ELSE
      EXECUTE format('REVOKE ALL PRIVILEGES ON public.mining_behavior_daily FROM %I CASCADE',pg_get_userbyid(r.grantee));
      IF r.can_select THEN EXECUTE format('GRANT SELECT ON public.mining_behavior_daily TO %I',pg_get_userbyid(r.grantee)); END IF;
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON public.mining_behavior_daily TO zcash_user;
COMMENT ON TABLE public.mining_behavior_daily IS
'Attributed miner payout output cohorts by completed UTC reward date. Exact zatoshis; current indexed spending at recomputation time, not historical spending-day flows or proof of sales. Missing/unattributed payouts are excluded.';
COMMIT;
