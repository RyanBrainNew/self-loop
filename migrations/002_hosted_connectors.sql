-- Hosted connector credentials, bindings, and ingress rate limits.
-- Apply after 001_hosted.sql.

ALTER TABLE connector_secrets
  ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS secret_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS secret_iv TEXT,
  ADD COLUMN IF NOT EXISTS secret_tag TEXT,
  ADD COLUMN IF NOT EXISTS key_version TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE connector_bindings (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'slack', 'jira', 'generic')),
  external_id TEXT NOT NULL,
  credential_id UUID REFERENCES connector_secrets(id) ON DELETE SET NULL,
  allowed_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE TABLE ingress_rate_limits (
  binding_id UUID NOT NULL REFERENCES connector_bindings(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (binding_id, window_start)
);

CREATE INDEX connector_bindings_project_idx
  ON connector_bindings (tenant_id, project_id, provider);
CREATE INDEX connector_secrets_project_idx
  ON connector_secrets (tenant_id, project_id, provider, created_at DESC);
CREATE INDEX ingress_rate_limits_expiry_idx
  ON ingress_rate_limits (window_start);

ALTER TABLE connector_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingress_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON connector_bindings
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON ingress_rate_limits
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);

-- Webhook ingress does not know the tenant before resolution. This controlled
-- SECURITY DEFINER function returns only one binding row for an exact provider
-- and external id; callers never get a general cross-tenant table scan.
CREATE OR REPLACE FUNCTION resolve_connector_binding(
  p_provider TEXT,
  p_external_id TEXT
)
RETURNS TABLE (
  id UUID,
  tenant_id UUID,
  project_id UUID,
  source_id UUID,
  credential_id UUID,
  allowed_channels JSONB,
  enabled BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id, b.tenant_id, b.project_id, b.source_id, b.credential_id,
         b.allowed_channels, b.enabled
  FROM connector_bindings b
  WHERE b.provider = p_provider
    AND b.external_id = p_external_id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION resolve_connector_binding(TEXT, TEXT) FROM PUBLIC;
-- Grant EXECUTE to the least-privilege hosted application role in deployment:
-- GRANT EXECUTE ON FUNCTION resolve_connector_binding(TEXT, TEXT) TO self_loop_app;
