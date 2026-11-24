-- Hosted control plane schema. This migration is intentionally separate from
-- the local JSON/SQLite stores and is not used by `npm run serve`.

CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY,
  oidc_issuer TEXT NOT NULL,
  oidc_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE memberships (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'operator', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE projects (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  repo_url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  state_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE project_memberships (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'maintainer', 'operator', 'viewer')),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE events (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  type TEXT NOT NULL,
  action TEXT,
  external_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ,
  UNIQUE (tenant_id, project_id, idempotency_key)
);

CREATE TABLE tickets (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number BIGINT NOT NULL,
  state TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE attempts (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  worker_id UUID,
  result JSONB,
  evidence_uri TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (ticket_id, number)
);

CREATE TABLE sources (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'healthy',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  health JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE connector_secrets (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, idempotency_key)
);

CREATE TABLE workers (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  concurrency INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT NOT NULL,
  last_heartbeat_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  ip INET,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hosted_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_transactions (
  token_hash TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_pending_idx
  ON events (tenant_id, project_id, received_at)
  WHERE status = 'pending';
CREATE INDEX tickets_state_idx
  ON tickets (tenant_id, project_id, state, updated_at);
CREATE INDEX tickets_claim_idx
  ON tickets (tenant_id, project_id, updated_at)
  WHERE state = 'queued';
CREATE INDEX deliveries_due_idx
  ON deliveries (tenant_id, project_id, next_attempt_at)
  WHERE state IN ('pending', 'failed');
CREATE INDEX audit_tenant_time_idx
  ON audit_log (tenant_id, created_at DESC);
CREATE INDEX hosted_sessions_expiry_idx
  ON hosted_sessions (expires_at);
CREATE INDEX login_transactions_expiry_idx
  ON login_transactions (expires_at);

-- Every hosted request sets `self_loop.tenant_id` inside its transaction.
-- Application code must also add an explicit tenant predicate; RLS is defense
-- in depth, not a replacement for RBAC.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON projects
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON project_memberships
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON events
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON tickets
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON attempts
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON sources
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON connector_secrets
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON deliveries
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON workers
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = current_setting('self_loop.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('self_loop.tenant_id', true)::uuid);
CREATE POLICY membership_self ON memberships
  USING (user_id = current_setting('self_loop.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('self_loop.user_id', true)::uuid);
CREATE POLICY project_membership_self ON project_memberships
  USING (user_id = current_setting('self_loop.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('self_loop.user_id', true)::uuid);
