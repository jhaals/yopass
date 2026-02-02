// Package main provides a simple healthcheck binary for Docker HEALTHCHECK
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	url := flag.String("url", "http://localhost:1337/healthz", "URL to check")
	timeout := flag.Duration("timeout", 5*time.Second, "Request timeout")
	flag.Parse()

	client := &http.Client{Timeout: *timeout}
	resp, err := client.Get(*url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Health check failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Health check failed: status %d\n", resp.StatusCode)
		os.Exit(1)
	}

	os.Exit(0)
}
