-- 039_cluster_node_direct_links — optional direct TLS path to a node's slot gate.
--
-- When set, remote slot traffic dials kin-slot-gate at address:port with one
-- TLS connection per request instead of a channel on the long-lived SSH link.
-- cert_sha256 pins the gate's self-signed certificate (read over SSH); token
-- authorizes the connection and goes through maybeEncrypt.

CREATE TABLE IF NOT EXISTS cluster_node_direct_links (
  node_id TEXT PRIMARY KEY REFERENCES cluster_nodes(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  port INTEGER NOT NULL,
  token TEXT NOT NULL,
  cert_sha256 TEXT,
  updated_at TEXT NOT NULL
);
