package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/dofastted/kin-gateway/worker/internal/slotgate"
)

func main() {
	configPath := flag.String("config", "", "path to gate JSON config")
	flag.Parse()
	data, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("read gate config: %v", err)
	}
	var cfg slotgate.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		log.Fatalf("decode gate config: %v", err)
	}
	srv, err := slotgate.New(cfg)
	if err != nil {
		log.Fatalf("kin-slot-gate: %v", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Printf("kin-slot-gate listening on %s", cfg.Listen)
	if err = srv.Serve(ctx); err != nil {
		log.Fatalf("kin-slot-gate serve: %v", err)
	}
}
