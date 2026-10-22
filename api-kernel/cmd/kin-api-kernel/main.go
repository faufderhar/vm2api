package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/dofastted/kin-gateway/api-kernel/internal/pool"
	"github.com/dofastted/kin-gateway/api-kernel/internal/server"
)

// tokenEnv carries the internal token; /proc/<pid>/environ is readable only by the same user.
const tokenEnv = "KIN_API_KERNEL_SECRET"

func main() {
	socket := flag.String("socket", "", "unix socket path")
	token := flag.String("token", "", "internal token (prefer "+tokenEnv+": argv is world-readable in /proc)")
	flag.Parse()
	if *socket == "" {
		log.Fatal(" -socket is required")
	}
	if env := strings.TrimSpace(os.Getenv(tokenEnv)); env != "" {
		*token = env
	}
	if strings.TrimSpace(*token) == "" {
		log.Fatal(tokenEnv + " or -token is required")
	}
	socketDir := filepath.Dir(*socket)
	if err := os.MkdirAll(socketDir, 0o700); err != nil {
		log.Fatalf("socket dir: %v", err)
	}
	_ = os.Chmod(socketDir, 0o700)
	_ = os.Remove(*socket)
	ln, err := net.Listen("unix", *socket)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	_ = os.Chmod(*socket, 0o600)

	srv := &http.Server{
		Handler:           (&server.Server{Token: *token, Pool: pool.NewManager()}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if serveErr := srv.Serve(ln); serveErr != nil && serveErr != http.ErrServerClosed {
			log.Fatalf("serve: %v", serveErr)
		}
	}()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = os.Remove(*socket)
}
