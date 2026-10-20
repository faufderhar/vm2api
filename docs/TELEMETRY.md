# VM telemetry service

Telemetry is an explicit seed-policy opt-in. A newly created VM is disabled;
setting `telemetry_disabled` to `false` writes the VM's `worker.json` identity
and starts the Go `kin-worker telemetry` service. Setting it back to `true`
stops that child process and leaves the VM and its Rust kernel running.

The service reads credentials only from the VM's own Claude home. Its feature
payload uses facts collected from that VM (including its timezone, OS,
hardware, shell and runtime versions), never controller-host defaults or a
synthetic fingerprint. Requests leave through the VM's bound egress, so the
service observes the VM's actual network address. Uploads are periodic and are idle-gated
by `run/telemetry.touch`.

`claude.setting` is a plain, editable seed file beside `settings.json` and is
initialized with:

```text
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

## Service-only updates

Go payloads are copied atomically into each slot's persistent `slot-bin`
directory. Cluster containers bind that directory at `/opt/kin-live` (and the
KVM guest payload at `/opt/kin-live`). The panel/fleet `telemetry` action
restarts only the telemetry child and the `kin-egress` helper; it does not
rebuild a VM, replace `vms/`, rotate credentials, or restart the Rust kernel.

An update must verify the new binary hash and the replacement process before
reporting success. A failed service restart is reported per slot so the old VM
identity remains intact and can be rolled back by republishing the previous
binary.

For a controlled rollout, run `scripts/migrate-legacy-cluster-slots.mjs` in
the control-plane container. Pass VM IDs after the root and concurrency
arguments to limit the rollout. It performs the same migration used by the
one-click installer: legacy slot and egress containers are stopped, renamed to
`*-legacy-<timestamp>`, and kept as stopped rollback copies; replacement
containers use the persistent `/opt/kin-live` mount. Container IDs therefore
change, but the VM, credentials, `vms/`, routing, and network identity do not.
After this one-time migration, subsequent updates atomically replace only the
Go binaries in `slot-bin` and restart the service processes.

## Upload audit log (debug)

Each successful or failed `PostBatch` / GrowthBook eval append one line to
`vms/<id>/run/telemetry-upload.log` (next to `worker.json`). The file keeps at
most 40 lines. Payload JSON is the request shape (`events` wrapper for batch
uploads) with identity fields stripped (email, account/org UUIDs, device and
session ids). The panel seed tab exposes this only when **调试上传** is on,
via `GET /api/panel/vms/:id/seed-settings?debug=1` → `telemetry_log` (string
array, last 40 lines).
