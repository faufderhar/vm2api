//go:build !linux

package slotgate

import (
	"fmt"
	"net"
	"os"
)

// Nodes are Linux; this keeps the package testable elsewhere (lstat, then dial).
func dialSlotSocket(path string) (net.Conn, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if st.Mode()&os.ModeSocket == 0 {
		return nil, fmt.Errorf("%s is not a socket", path)
	}
	return net.Dial("unix", path)
}
