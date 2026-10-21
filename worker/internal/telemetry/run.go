package telemetry

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

const (
	sessionTTL           = 10 * time.Minute
	defaultBatchInterval = 10 * time.Minute
	minBatchInterval     = 60 * time.Second
	maxBatchInterval     = 24 * time.Hour
	growthbookInterval   = 6 * time.Hour
	tickInterval         = time.Second
	touchName            = "telemetry.touch"
)

func batchInterval(tel config.TelemetryConfig) time.Duration {
	d := time.Duration(tel.UploadIntervalSecs) * time.Second
	if d < minBatchInterval || d > maxBatchInterval {
		return defaultBatchInterval
	}
	return d
}

type Deps struct {
	HTTP       *Client
	Store      *credential.Store
	Now        func() time.Time
	Sleep      func(ctx context.Context, d time.Duration) bool
	RetryWait  time.Duration
	TouchPath  string
	ConfigPath string
	LoadConfig func(path string) (config.TelemetryConfig, error)
}

func defaultSleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func TouchPath(cfg config.Config) string {
	if strings.TrimSpace(cfg.ConfigPath) == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(cfg.ConfigPath), touchName)
}

func WriteTouch(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	return os.WriteFile(path, []byte(time.Now().UTC().Format(time.RFC3339Nano)+"\n"), 0o600)
}

func lastActivity(path string, fallback time.Time) time.Time {
	if strings.TrimSpace(path) == "" {
		return fallback
	}
	info, err := os.Stat(path)
	if err != nil {
		return fallback
	}
	return info.ModTime()
}

// Run mirrors cc-bridge telemetry_loop:
// /v1 (or worker start) activates a 10-minute session.
// tengu_api_success batches at upload_interval_seconds (60s–24h, default 10 min).
// Every 6h (first immediate): GrowthBook /api/eval.
// worker.json telemetry is re-read when the file mtime moves, so identity,
// betas, headers, env, enabled, and upload interval flip without bouncing the process.
// A disabled config with no file still returns immediately.
func Run(ctx context.Context, cfg config.Config, deps Deps) error {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Sleep == nil {
		deps.Sleep = defaultSleep
	}
	if deps.TouchPath == "" {
		deps.TouchPath = TouchPath(cfg)
	}
	tel := cfg.Telemetry
	configPath := strings.TrimSpace(deps.ConfigPath)
	if configPath == "" {
		configPath = strings.TrimSpace(cfg.ConfigPath)
	}
	loadTelemetry := deps.LoadConfig
	if loadTelemetry == nil {
		loadTelemetry = config.LoadTelemetry
	}
	var seen time.Time
	var loadedKey string
	refresh := func() {
		if configPath == "" {
			return
		}
		info, err := os.Stat(configPath)
		if err != nil {
			return
		}
		if !seen.IsZero() && !info.ModTime().After(seen) {
			return
		}
		next, err := loadTelemetry(configPath)
		if err != nil {
			log.Printf("telemetry sidecar: reload skipped")
			seen = info.ModTime()
			return
		}
		tel = next
		seen = info.ModTime()
	}
	refresh()
	if !tel.Enabled && configPath == "" {
		return nil
	}
	started := deps.Now()
	var lastBatch time.Time
	var lastGrowthbook time.Time
	sentInit := false
	batchOK := true
	evalOK := true

	for {
		if ctx.Err() != nil {
			return nil
		}
		refresh()
		now := deps.Now()
		if !tel.Enabled {
			loadedKey = ""
			sentInit = false
			if !deps.Sleep(ctx, tickInterval) {
				return nil
			}
			continue
		}
		if key := telemetryKey(tel); key != loadedKey {
			sentInit = false
			loadedKey = key
		}
		activity := lastActivity(deps.TouchPath, started)
		if now.Sub(activity) > sessionTTL {
			if !deps.Sleep(ctx, tickInterval) {
				return nil
			}
			continue
		}
		identity := overlayIdentity(tel.Identity, credOrEmpty(deps))
		if strings.TrimSpace(identity.Betas) == "" {
			identity.Betas = strings.TrimSpace(tel.Betas)
		}
		token := accessToken(deps)
		if token == "" {
			if !deps.Sleep(ctx, tickInterval) {
				return nil
			}
			continue
		}
		live := cfg
		live.Telemetry = tel

		if !sentInit {
			ev := InitEvent(identity, now)
			if err := postBatch(ctx, deps, live, token, ev); err != nil {
				if stopOn4xx(err) {
					return nil
				}
			} else {
				sentInit = true
			}
		}

		if batchOK && (lastBatch.IsZero() || now.Sub(lastBatch) >= batchInterval(tel)) {
			uptime := now.Sub(started).Seconds()
			ev := SuccessEvent(identity, now, uptime, "")
			if err := postBatch(ctx, deps, live, token, ev); err != nil {
				if stopOn4xx(err) {
					batchOK = false
				}
			} else {
				lastBatch = now
			}
		}

		if evalOK && (lastGrowthbook.IsZero() || now.Sub(lastGrowthbook) >= growthbookInterval) {
			if err := postEval(ctx, deps, live, token, GrowthbookEval(identity)); err != nil {
				if stopOn4xx(err) {
					evalOK = false
				}
			} else {
				lastGrowthbook = now
			}
		}

		if !deps.Sleep(ctx, tickInterval) {
			return nil
		}
	}
}

func telemetryKey(tel config.TelemetryConfig) string {
	id := tel.Identity
	return strings.Join([]string{
		id.DeviceID,
		id.UserID,
		id.SessionID,
		id.CLIVersion,
		id.Source,
		tel.Betas,
		id.Betas,
	}, "|")
}

func credOrEmpty(deps Deps) credential.Credential {
	if deps.Store == nil {
		return credential.Credential{}
	}
	cred, err := deps.Store.Status()
	if err != nil {
		return credential.Credential{}
	}
	return cred
}

func accessToken(deps Deps) string {
	if deps.Store == nil {
		return ""
	}
	cred, err := deps.Store.Status()
	if err != nil || !cred.Valid() || cred.IsAPIKey() || cred.NeedsRefresh(deps.Now(), time.Minute) {
		return ""
	}
	return cred.AccessToken
}

func postBatch(ctx context.Context, deps Deps, cfg config.Config, token string, ev Event) error {
	if deps.HTTP == nil {
		return nil
	}
	err := deps.HTTP.PostBatch(ctx, token, cfg.Telemetry.Headers, []Event{ev})
	recordUpload(cfg, "batch", ev.EventData["event_name"], err, BatchRequest{Events: []Event{ev}})
	return err
}

func postEval(ctx context.Context, deps Deps, cfg config.Config, token string, body map[string]any) error {
	if deps.HTTP == nil {
		return nil
	}
	err := deps.HTTP.PostEval(ctx, token, cfg.Telemetry.Headers, body)
	recordUpload(cfg, "eval", "growthbook", err, body)
	return err
}

const uploadLogLines = 40

var redactedUploadKeys = map[string]struct{}{
	"email": {}, "account_uuid": {}, "accountuuid": {},
	"organization_uuid": {}, "organizationuuid": {},
	"device_id": {}, "deviceid": {}, "session_id": {}, "sessionid": {},
	"user_id": {}, "userid": {}, "id": {},
}

func recordUpload(cfg config.Config, kind string, name any, err error, payload any) {
	if strings.TrimSpace(cfg.ConfigPath) == "" {
		return
	}
	body, marshalErr := json.Marshal(redactUpload(payload))
	if marshalErr != nil {
		body = []byte("{}")
	}
	state := "ok"
	if err != nil {
		class, status := ClassifyBatchErr(err)
		state = class
		log.Printf("telemetry sidecar: %s failed class=%s status=%d", kind, class, status)
		_ = status
	}
	line := time.Now().UTC().Format(time.RFC3339) + " " + kind + " " + strings.TrimSpace(fmtName(name)) + " " + state + " " + string(body)
	path := filepath.Join(filepath.Dir(cfg.ConfigPath), "telemetry-upload.log")
	_ = rewriteUploadLog(path, line)
}

func redactUpload(value any) any {
	switch item := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(item))
		for key, child := range item {
			if _, drop := redactedUploadKeys[strings.ToLower(key)]; drop {
				continue
			}
			out[key] = redactUpload(child)
		}
		return out
	case []any:
		out := make([]any, len(item))
		for i, child := range item {
			out[i] = redactUpload(child)
		}
		return out
	case []Event:
		out := make([]any, len(item))
		for i, child := range item {
			out[i] = redactUpload(child)
		}
		return out
	case BatchRequest:
		return map[string]any{"events": redactUpload(item.Events)}
	case Event:
		return redactUpload(map[string]any{"event_type": item.EventType, "event_data": item.EventData})
	default:
		return value
	}
}

func rewriteUploadLog(path, line string) error {
	previous, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimRight(string(previous), "\n"), "\n")
	if len(previous) == 0 {
		lines = nil
	}
	lines = append(lines, line)
	if len(lines) > uploadLogLines {
		lines = lines[len(lines)-uploadLogLines:]
	}
	next := path + ".next"
	if err := os.WriteFile(next, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(next, path)
}

func fmtName(name any) string {
	text, _ := name.(string)
	if text == "" {
		return "-"
	}
	return text
}

func stopOn4xx(err error) bool {
	class, status := ClassifyBatchErr(err)
	return class == "status" && status >= 400 && status < 500
}

func overlayIdentity(id config.TelemetryIdentity, cred credential.Credential) config.TelemetryIdentity {
	if strings.TrimSpace(cred.Email) != "" {
		id.Email = cred.Email
	}
	if strings.TrimSpace(cred.AccountUUID) != "" {
		id.AccountUUID = cred.AccountUUID
	}
	if strings.TrimSpace(cred.OrgUUID) != "" {
		id.OrgUUID = cred.OrgUUID
	}
	if strings.TrimSpace(id.Platform) == "" {
		id.Platform = defaultPlatform
	}
	if strings.TrimSpace(id.Entrypoint) == "" {
		id.Entrypoint = "cli"
	}
	return id
}
