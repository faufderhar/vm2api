package pool

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

type dialPinKey struct{}

// WithDialIP tells DialContext to connect to ip instead of resolving addr again.
func WithDialIP(ctx context.Context, ip net.IP) context.Context {
	if ip == nil {
		return ctx
	}
	return context.WithValue(ctx, dialPinKey{}, ip)
}

func pinnedAddr(ctx context.Context, addr string) string {
	ip, _ := ctx.Value(dialPinKey{}).(net.IP)
	if ip == nil {
		return addr
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil || port == "" {
		return addr
	}
	return net.JoinHostPort(ip.String(), port)
}

func pinDial(base func(context.Context, string, string) (net.Conn, error)) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		return base(ctx, network, pinnedAddr(ctx, addr))
	}
}

const (
	maxIdleConns        = 4096
	maxIdleConnsPerHost = 2048
	maxConnsPerHost     = 8192
	idleConnTimeout     = 90 * time.Second
	dialTimeout         = 10 * time.Second
	tlsHandshakeTimeout = 10 * time.Second
	responseHeaderWait  = 300 * time.Second
	clientIdleTTL       = 30 * time.Minute
)

type pooledClient struct {
	client   *http.Client
	lastUsed time.Time
}

type Manager struct {
	mu      sync.Mutex
	clients map[string]*pooledClient
}

func NewManager() *Manager {
	return &Manager{clients: make(map[string]*pooledClient)}
}

func (m *Manager) Client(proxyURL string) (*http.Client, error) {
	key := proxyURL
	if key == "" || key == "direct" {
		key = "direct"
	}
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.evictIdle(now, key)
	if pc, ok := m.clients[key]; ok {
		pc.lastUsed = now
		return pc.client, nil
	}
	c, err := newClient(key)
	if err != nil {
		return nil, err
	}
	m.clients[key] = &pooledClient{client: c, lastUsed: now}
	return c, nil
}

// In-flight requests keep their client alive; eviction only drops idle sockets and the cache entry.
func (m *Manager) evictIdle(now time.Time, keep string) {
	for k, pc := range m.clients {
		if k != keep && now.Sub(pc.lastUsed) > clientIdleTTL {
			pc.client.CloseIdleConnections()
			delete(m.clients, k)
		}
	}
}

func newClient(proxyKey string) (*http.Client, error) {
	dialer := &net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          maxIdleConns,
		MaxIdleConnsPerHost:   maxIdleConnsPerHost,
		MaxConnsPerHost:       maxConnsPerHost,
		IdleConnTimeout:       idleConnTimeout,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ResponseHeaderTimeout: responseHeaderWait,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
	}
	if proxyKey != "" && proxyKey != "direct" {
		u, err := url.Parse(proxyKey)
		if err != nil {
			return nil, err
		}
		if u.Scheme == "socks5" || u.Scheme == "socks5h" {
			auth := &proxy.Auth{}
			if u.User != nil {
				auth.User = u.User.Username()
				auth.Password, _ = u.User.Password()
			}
			var socksAuth *proxy.Auth
			if u.User != nil {
				socksAuth = auth
			}
			d, err := proxy.SOCKS5("tcp", u.Host, socksAuth, dialer)
			if err != nil {
				return nil, err
			}
			contextDialer, ok := d.(proxy.ContextDialer)
			if ok {
				transport.DialContext = pinDial(contextDialer.DialContext)
			} else {
				transport.DialContext = pinDial(func(ctx context.Context, network, addr string) (net.Conn, error) {
					return d.Dial(network, addr)
				})
			}
		} else {
			transport.Proxy = http.ProxyURL(u)
		}
	} else {
		transport.DialContext = pinDial(dialer.DialContext)
	}
	return &http.Client{Transport: transport, Timeout: 0, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}, nil
}
