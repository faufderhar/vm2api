package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
)

type Server struct {
	Token string
	Pool  *pool.Manager
}

type forwardEnv struct {
	Method       string            `json:"method"`
	URL          string            `json:"url"`
	Headers      map[string]string `json:"headers"`
	Body         string            `json:"body"`
	ProxyURL     string            `json:"proxy_url"`
	Stream       bool              `json:"stream"`
	RequireProxy bool              `json:"require_proxy"`
	TimeoutMs    int               `json:"timeout_ms"`
}

const streamChunk = 32 * 1024

// accept-encoding is dropped so the Go transport negotiates gzip itself and decompresses transparently.
var droppedRequestHeaders = map[string]bool{
	"connection":        true,
	"keep-alive":        true,
	"proxy-connection":  true,
	"transfer-encoding": true,
	"upgrade":           true,
	"te":                true,
	"trailer":           true,
	"accept-encoding":   true,
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/health", s.authorize(s.health))
	mux.HandleFunc("POST /internal/forward", s.authorize(s.forward))
	return mux
}

func (s *Server) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSpace(s.Token)
		got := strings.TrimSpace(r.Header.Get("X-Kin-Internal-Token"))
		if token == "" || !sameSecret(token, got) {
			kernelError(w, http.StatusUnauthorized, `{"ok":false,"error":{"code":"internal_auth_failed"}}`)
			return
		}
		next(w, r)
	}
}

func sameSecret(left, right string) bool {
	a := sha256.Sum256([]byte(left))
	b := sha256.Sum256([]byte(right))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

func kernelError(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("X-Kin-Kernel-Error", "1")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"kernel":"api"}`))
}

func proxyAllowed(raw string) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "direct" {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	switch u.Scheme {
	case "socks5", "socks5h", "http", "https":
		return true
	}
	return false
}

func (s *Server) forward(w http.ResponseWriter, r *http.Request) {
	var env forwardEnv
	if err := json.NewDecoder(r.Body).Decode(&env); err != nil {
		kernelError(w, http.StatusBadRequest, `{"ok":false,"error":{"code":"bad_envelope"}}`)
		return
	}
	method := strings.ToUpper(strings.TrimSpace(env.Method))
	if method == "" {
		method = http.MethodPost
	}
	if !strings.HasPrefix(env.URL, "http://") && !strings.HasPrefix(env.URL, "https://") {
		kernelError(w, http.StatusBadRequest, `{"ok":false,"error":{"code":"invalid_url"}}`)
		return
	}
	if env.RequireProxy && !proxyAllowed(env.ProxyURL) {
		kernelError(w, http.StatusBadRequest, `{"ok":false,"error":{"code":"proxy_required"}}`)
		return
	}
	client, err := s.Pool.Client(env.ProxyURL)
	if err != nil {
		kernelError(w, http.StatusBadRequest, `{"ok":false,"error":{"code":"proxy_invalid"}}`)
		return
	}
	ctx := r.Context()
	if env.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(env.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	up, err := http.NewRequestWithContext(ctx, method, env.URL, strings.NewReader(env.Body))
	if err != nil {
		kernelError(w, http.StatusInternalServerError, `{"ok":false,"error":{"code":"build_failed"}}`)
		return
	}
	for k, v := range env.Headers {
		if strings.TrimSpace(v) == "" || droppedRequestHeaders[strings.ToLower(k)] {
			continue
		}
		up.Header.Set(k, v)
	}
	resp, err := client.Do(up)
	if err != nil {
		kernelError(w, http.StatusBadGateway, `{"ok":false,"error":{"code":"upstream_transport","message":`+jsonQuote(err.Error())+`}}`)
		return
	}
	defer resp.Body.Close()
	for k, vals := range resp.Header {
		lk := strings.ToLower(k)
		if lk == "connection" || lk == "transfer-encoding" {
			continue
		}
		if resp.Uncompressed && (lk == "content-length" || lk == "content-encoding") {
			continue
		}
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if env.Stream || strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream") {
		copyFlush(w, resp.Body)
		return
	}
	_, _ = io.Copy(w, resp.Body)
}

func copyFlush(w http.ResponseWriter, body io.Reader) {
	rc := http.NewResponseController(w)
	flush := func() bool {
		err := rc.Flush()
		return err == nil || errors.Is(err, http.ErrNotSupported)
	}
	if !flush() {
		return
	}
	buf := make([]byte, streamChunk)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if !flush() {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
