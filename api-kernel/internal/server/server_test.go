package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
)

func TestForwardCopiesUpstream(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("X-Api-Key") != "sk-test" {
			t.Fatalf("missing x-api-key")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: {\"type\":\"message_stop\"}\n\n")
	}))
	defer up.Close()

	h := (&Server{Token: "t", Pool: pool.NewManager()}).Handler()
	env, _ := json.Marshal(forwardEnv{
		Method:  "POST",
		URL:     up.URL + "/v1/messages?beta=true",
		Headers: map[string]string{"x-api-key": "sk-test"},
		Body:    `{"model":"x"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/forward", strings.NewReader(string(env)))
	req.Header.Set("X-Kin-Internal-Token", "t")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "message_stop") {
		t.Fatalf("body %s", rec.Body.String())
	}
}

func TestEmptyTokenIsRejected(t *testing.T) {
	h := (&Server{Token: "", Pool: pool.NewManager()}).Handler()
	req := httptest.NewRequest(http.MethodGet, "/internal/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", rec.Code)
	}
}

func forwardRequest(t *testing.T, ctx context.Context, base string, env forwardEnv) *http.Response {
	t.Helper()
	raw, _ := json.Marshal(env)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/internal/forward", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Kin-Internal-Token", "t")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func newKernel(t *testing.T) *httptest.Server {
	t.Helper()
	k := httptest.NewServer((&Server{Token: "t", Pool: pool.NewManager()}).Handler())
	t.Cleanup(k.Close)
	return k
}

func TestForwardFlushesSSEBeforeUpstreamCompletes(t *testing.T) {
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
		_, _ = io.WriteString(w, "data: second\n\n")
	}))
	defer up.Close()
	defer close(release)

	kernel := newKernel(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	got := make(chan string, 1)
	go func() {
		raw, _ := json.Marshal(forwardEnv{Method: "POST", URL: up.URL})
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, kernel.URL+"/internal/forward", bytes.NewReader(raw))
		req.Header.Set("X-Kin-Internal-Token", "t")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			got <- "error: " + err.Error()
			return
		}
		defer resp.Body.Close()
		line, _ := bufio.NewReader(resp.Body).ReadString('\n')
		got <- line
	}()
	select {
	case line := <-got:
		if line != "data: first\n" {
			t.Fatalf("first line %q", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("first SSE event was not flushed before upstream completed")
	}
}

func TestForwardRequireProxyRejectsDirect(t *testing.T) {
	var hits atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer up.Close()

	h := (&Server{Token: "t", Pool: pool.NewManager()}).Handler()
	for _, proxyURL := range []string{"", "direct", "ftp://127.0.0.1:21", "socks4://127.0.0.1:1080"} {
		env, _ := json.Marshal(forwardEnv{URL: up.URL, ProxyURL: proxyURL, RequireProxy: true})
		req := httptest.NewRequest(http.MethodPost, "/internal/forward", bytes.NewReader(env))
		req.Header.Set("X-Kin-Internal-Token", "t")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"proxy_required"`) {
			t.Fatalf("proxy %q: status %d body %s", proxyURL, rec.Code, rec.Body.String())
		}
		if rec.Header().Get("X-Kin-Kernel-Error") != "1" {
			t.Fatalf("proxy %q: missing X-Kin-Kernel-Error", proxyURL)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Fatalf("proxy %q: content-type %q", proxyURL, ct)
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("upstream received %d requests", n)
	}
}

func TestForwardUpstreamErrorHasNoKernelMarker(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, `{"error":"bad gateway"}`)
	}))
	defer up.Close()

	resp := forwardRequest(t, context.Background(), newKernel(t).URL, forwardEnv{URL: up.URL})
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadGateway || string(body) != `{"error":"bad gateway"}` {
		t.Fatalf("status %d body %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Kin-Kernel-Error") != "" {
		t.Fatal("upstream passthrough carried X-Kin-Kernel-Error")
	}
}

func TestForwardTransportErrorHasKernelMarker(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead := up.URL
	up.Close()

	resp := forwardRequest(t, context.Background(), newKernel(t).URL, forwardEnv{URL: dead})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Kin-Kernel-Error") != "1" {
		t.Fatalf("status %d marker %q", resp.StatusCode, resp.Header.Get("X-Kin-Kernel-Error"))
	}
}

func TestForwardClientCancelReachesUpstream(t *testing.T) {
	upstreamStarted := make(chan struct{})
	upstreamDone := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(upstreamStarted)
		<-r.Context().Done()
		close(upstreamDone)
	}))
	defer up.Close()

	kernel := newKernel(t)
	ctx, cancel := context.WithCancel(context.Background())
	raw, _ := json.Marshal(forwardEnv{URL: up.URL, Stream: true})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, kernel.URL+"/internal/forward", bytes.NewReader(raw))
	req.Header.Set("X-Kin-Internal-Token", "t")
	go func() {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
		}
	}()
	select {
	case <-upstreamStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream never received the request")
	}
	cancel()
	select {
	case <-upstreamDone:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream request context was not cancelled")
	}
}

func TestForwardTimeoutMs(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer up.Close()

	start := time.Now()
	resp := forwardRequest(t, context.Background(), newKernel(t).URL, forwardEnv{URL: up.URL, TimeoutMs: 100})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Kin-Kernel-Error") != "1" {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("timeout_ms not applied")
	}
}

func TestForwardDropsHopByHopAndDecompresses(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Keep-Alive") != "" || r.Header.Get("Upgrade") != "" {
			t.Errorf("hop-by-hop header forwarded: %v", r.Header)
		}
		if r.Header.Get("Accept-Encoding") != "gzip" {
			t.Errorf("accept-encoding %q, want transport-managed gzip", r.Header.Get("Accept-Encoding"))
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "application/json")
		gz := gzip.NewWriter(w)
		_, _ = io.WriteString(gz, `{"ok":true}`)
		_ = gz.Close()
	}))
	defer up.Close()

	resp := forwardRequest(t, context.Background(), newKernel(t).URL, forwardEnv{
		URL:     up.URL,
		Headers: map[string]string{"Keep-Alive": "300", "Upgrade": "h2c", "Accept-Encoding": "br"},
	})
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"ok":true}` || resp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("body %q encoding %q", body, resp.Header.Get("Content-Encoding"))
	}
}
