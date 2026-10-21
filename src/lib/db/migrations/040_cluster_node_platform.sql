-- 040_cluster_node_platform — operating system of a cluster node.
--
-- 'linux' nodes run slots as Docker containers; 'darwin' nodes (Apple Silicon
-- Macs) run them as launchd services of the SSH user. Detected from `uname -s`
-- whenever the node's SSH link comes up; existing rows are Linux.

ALTER TABLE cluster_nodes ADD COLUMN platform TEXT NOT NULL DEFAULT 'linux';
