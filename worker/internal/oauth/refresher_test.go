package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

func TestEnsureDeduplicatesConcurrentRefresh(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		time.Sleep(30 * time.Millisecond)
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode refresh body: %v", err)
		}
		if body["refresh_token"] != "refresh-1" || body["grant_type"] != "refresh_token" {
			t.Errorf("unexpected refresh body: %#v", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-2","refresh_token":"refresh-2","expires_in":28800,"scope":"user:inference"}`))
	}))
	defer upstream.Close()

	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{
		Store:    store,
		Client:   upstream.Client(),
		TokenURL: upstream.URL,
		Skew:     5 * time.Minute,
		MaxTries: 1,
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := refresher.Ensure(context.Background(), false)
			if err != nil {
				t.Errorf("Ensure: %v", err)
				return
			}
			if result.Credential.AccessToken != "access-2" {
				t.Errorf("access token = %q", result.Credential.AccessToken)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("refresh calls = %d, want 1", calls.Load())
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.RefreshToken != "refresh-2" || current.AccessToken != "access-2" {
		t.Fatalf("stored credential = %#v", current)
	}
}

func TestEnsurePreservesSetupTokenTypeAndFullScopes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-2","refresh_token":"refresh-2","expires_in":28800,"scope":"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"}`))
	}))
	defer upstream.Close()

	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		Type:         credential.TypeSetupToken,
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
		Scopes: []string{
			"user:profile",
			"user:inference",
			"user:sessions:claude_code",
			"user:mcp_servers",
			"user:file_upload",
		},
	}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1}
	if _, err := refresher.Ensure(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.Type != credential.TypeSetupToken || current.RefreshToken != "refresh-2" {
		t.Fatalf("stored credential = %#v, want setup-token with rotated refresh", current)
	}
	if got := strings.Join(current.Scopes, " "); got != "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload" {
		t.Fatalf("scopes = %q", got)
	}
}

func TestEnsurePersistsRefreshWhenCallerContextCancels(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if calls.Add(1) != 1 {
			<-request.Context().Done()
			return
		}
		close(entered)
		<-release
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-new","refresh_token":"refresh-new","expires_in":28800}`))
	}))
	defer upstream.Close()
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		AccessToken:  "access-old",
		RefreshToken: "refresh-old",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{
		Store:          store,
		Client:         upstream.Client(),
		TokenURL:       upstream.URL,
		MaxTries:       1,
		RequestTimeout: 2 * time.Second,
	}
	leaderCtx, leaderCancel := context.WithCancel(context.Background())
	defer leaderCancel()
	leaderDone := make(chan error, 1)
	go func() {
		_, err := refresher.Ensure(leaderCtx, true)
		leaderDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("refresh did not reach the token endpoint")
	}
	waiterDone := make(chan error, 1)
	go func() {
		_, err := refresher.Ensure(context.Background(), true)
		waiterDone <- err
	}()
	time.Sleep(100 * time.Millisecond)
	leaderCancel()
	close(release)
	select {
	case err := <-leaderDone:
		if err != nil {
			t.Fatalf("leader Ensure: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("leader did not finish")
	}
	select {
	case err := <-waiterDone:
		if err != nil {
			t.Fatalf("waiter Ensure: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("waiter did not finish")
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.RefreshToken != "refresh-new" || current.AccessToken != "access-new" {
		t.Fatalf("rotated credential was not saved: %#v", current)
	}
}

func TestWaiterRetriesWhenLeaderContextEndsDuringLockWait(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"access_token":"access-2","refresh_token":"refresh-2","expires_in":28800}`))
	}))
	defer upstream.Close()
	store := credential.NewStore(filepath.Join(t.TempDir(), "credentials.json"))
	if _, err := store.Save(credential.Credential{
		AccessToken:  "access-old",
		RefreshToken: "refresh-old",
		ExpiresAt:    time.Now().Add(-time.Minute).UnixMilli(),
	}, nil); err != nil {
		t.Fatal(err)
	}
	refresher := &Refresher{Store: store, Client: upstream.Client(), TokenURL: upstream.URL, MaxTries: 1, RequestTimeout: 2 * time.Second}

	held := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	go func() {
		if err := store.WithLock(context.Background(), func() error {
			close(held)
			<-release
			return nil
		}); err != nil {
			t.Errorf("hold credential lock: %v", err)
		}
	}()
	select {
	case <-held:
	case <-time.After(2 * time.Second):
		t.Fatal("failed to hold the credential lock")
	}

	leaderCtx, leaderCancel := context.WithCancel(context.Background())
	defer leaderCancel()
	leaderDone := make(chan error, 1)
	go func() {
		_, err := refresher.Ensure(leaderCtx, true)
		leaderDone <- err
	}()
	time.Sleep(50 * time.Millisecond)
	waiterDone := make(chan error, 1)
	go func() {
		_, err := refresher.Ensure(context.Background(), true)
		waiterDone <- err
	}()
	time.Sleep(50 * time.Millisecond)
	leaderCancel()
	select {
	case err := <-leaderDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("leader err = %v, want context canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not leave the lock wait")
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-waiterDone:
		if err != nil {
			t.Fatalf("waiter Ensure: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("waiter did not finish")
	}
	current, err := store.Status()
	if err != nil {
		t.Fatal(err)
	}
	if current.RefreshToken != "refresh-2" {
		t.Fatalf("waiter did not persist the refresh: %#v", current)
	}
}
