-- Per-device AI chat history. Device is identified by a client-generated
-- UUID stored in localStorage; no user account is required. user_id +
-- list_type are denormalised so the assistant can reason about which
-- Netfugl context the device is associated with at message time.
CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL   PRIMARY KEY,
  device_id   TEXT        NOT NULL,
  user_id     TEXT,
  list_type   TEXT,
  role        TEXT        NOT NULL,  -- 'user' | 'assistant' | 'tool' | 'system'
  content     TEXT,
  tool_calls  JSONB,                 -- assistant tool_calls payload
  tool_name   TEXT,                  -- when role='tool'
  tool_call_id TEXT,                 -- when role='tool', for OpenAI threading
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_device_time_idx
  ON chat_messages (device_id, created_at);
