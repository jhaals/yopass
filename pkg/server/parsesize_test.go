package server

import (
	"testing"
)

func TestParseSize(t *testing.T) {
	tests := []struct {
		input    string
		expected int64
		wantErr  bool
	}{
		// Plain integers
		{"0", 0, false},
		{"1024", 1024, false},
		{"10000", 10000, false},

		// Kilobytes
		{"1K", 1024, false},
		{"1k", 1024, false},
		{"1KB", 1024, false},
		{"1kb", 1024, false},
		{"500K", 512000, false},

		// Megabytes
		{"1M", 1048576, false},
		{"1m", 1048576, false},
		{"1MB", 1048576, false},
		{"14M", 14680064, false},
		{"1.5M", 1572864, false},

		// Gigabytes
		{"1G", 1073741824, false},
		{"1g", 1073741824, false},
		{"1GB", 1073741824, false},
		{"1.5G", 1610612736, false},
		{"5G", 5368709120, false},

		// Edge cases
		{" 1M ", 1048576, false},
		{"0M", 0, false},

		// Errors
		{"", 0, true},
		{"abc", 0, true},
		{"-1M", 0, true},
		{"M", 0, true},
		{"1T", 0, true},
		{"1.2.3M", 0, true},
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			result, err := ParseSize(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for input %q, got %d", tc.input, result)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for input %q: %v", tc.input, err)
			}
			if result != tc.expected {
				t.Fatalf("ParseSize(%q) = %d, want %d", tc.input, result, tc.expected)
			}
		})
	}
}
