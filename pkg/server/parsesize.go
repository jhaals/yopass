package server

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ParseSize parses a human-readable size string into bytes.
// Supported formats: plain integers ("10000"), or with suffix K/KB, M/MB, G/GB (case-insensitive).
// Binary units are used: 1K = 1024, 1M = 1048576, 1G = 1073741824.
// Decimal values are supported (e.g. "1.5GB").
func ParseSize(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty size string")
	}

	// Try plain integer first
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		if n < 0 {
			return 0, fmt.Errorf("size must be non-negative: %s", s)
		}
		return n, nil
	}

	upper := strings.ToUpper(s)

	var multiplier float64
	var numStr string

	switch {
	case strings.HasSuffix(upper, "GB"):
		numStr = s[:len(s)-2]
		multiplier = 1024 * 1024 * 1024
	case strings.HasSuffix(upper, "MB"):
		numStr = s[:len(s)-2]
		multiplier = 1024 * 1024
	case strings.HasSuffix(upper, "KB"):
		numStr = s[:len(s)-2]
		multiplier = 1024
	case strings.HasSuffix(upper, "G"):
		numStr = s[:len(s)-1]
		multiplier = 1024 * 1024 * 1024
	case strings.HasSuffix(upper, "M"):
		numStr = s[:len(s)-1]
		multiplier = 1024 * 1024
	case strings.HasSuffix(upper, "K"):
		numStr = s[:len(s)-1]
		multiplier = 1024
	default:
		return 0, fmt.Errorf("invalid size format: %s (use K, M, G, KB, MB, or GB suffix)", s)
	}

	numStr = strings.TrimSpace(numStr)
	if numStr == "" {
		return 0, fmt.Errorf("invalid size format: %s", s)
	}

	val, err := strconv.ParseFloat(numStr, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid size value: %s", s)
	}
	if val < 0 {
		return 0, fmt.Errorf("size must be non-negative: %s", s)
	}

	result := int64(math.Round(val * multiplier))
	return result, nil
}
