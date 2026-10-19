package pool

import (
	"testing"
	"time"
)

func TestClientEvictsIdleEntries(t *testing.T) {
	m := NewManager()
	stale, err := m.Client("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Client(""); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.clients["http://127.0.0.1:1"].lastUsed = time.Now().Add(-clientIdleTTL - time.Minute)
	m.mu.Unlock()

	if _, err := m.Client("direct"); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	_, kept := m.clients["http://127.0.0.1:1"]
	n := len(m.clients)
	m.mu.Unlock()
	if kept || n != 1 {
		t.Fatalf("stale client kept=%v entries=%d", kept, n)
	}
	fresh, err := m.Client("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	if fresh == stale {
		t.Fatal("expected a new client after eviction")
	}
}

func TestClientReusesActiveEntry(t *testing.T) {
	m := NewManager()
	a, _ := m.Client("")
	b, _ := m.Client("direct")
	if a != b {
		t.Fatal("direct client not reused")
	}
}
