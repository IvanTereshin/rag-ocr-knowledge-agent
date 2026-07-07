CREATE TABLE IF NOT EXISTS rag_ocr_users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_ocr_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
  csrf_token_hash text,
  expires_at text NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS rag_ocr_sessions_user_id_idx
ON rag_ocr_sessions(user_id);

CREATE TABLE IF NOT EXISTS rag_ocr_service_settings (
  user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  enabled boolean NOT NULL,
  label text NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  secret jsonb,
  proxy_secret jsonb,
  validation jsonb,
  updated_at text,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS rag_ocr_proxy_settings (
  user_id text PRIMARY KEY REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
  secret jsonb,
  updated_at text
);

CREATE TABLE IF NOT EXISTS rag_ocr_documents (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  file_name text NOT NULL,
  original_name text NOT NULL,
  file_type text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  status text NOT NULL,
  storage_path text NOT NULL,
  storage_key text,
  text_path text,
  text_content text,
  text_preview text,
  chunk_count integer,
  job_id text,
  queued_at text,
  processing_started_at text,
  processed_at text,
  pipeline_version text,
  pipeline jsonb,
  error text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

ALTER TABLE rag_ocr_documents
ADD COLUMN IF NOT EXISTS text_content text;

CREATE INDEX IF NOT EXISTS rag_ocr_documents_user_id_position_idx
ON rag_ocr_documents(user_id, position);

CREATE TABLE IF NOT EXISTS rag_ocr_document_chunks (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES rag_ocr_documents(id) ON DELETE CASCADE,
  document_name text NOT NULL,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  token_estimate integer NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS rag_ocr_document_chunks_document_id_idx
ON rag_ocr_document_chunks(document_id, chunk_index);

CREATE INDEX IF NOT EXISTS rag_ocr_document_chunks_user_id_idx
ON rag_ocr_document_chunks(user_id);
