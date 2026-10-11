package yopass

import "testing"

func TestParseExpirationDuration(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  int32
	}{
		{"1s", 1}, {"1m", 60}, {"1h", 3600}, {"1d", 86400}, {"1w", 604800},
		{"90d", 7776000}, {"1d12h30m", 131400}, {"2147483647s", 2147483647},
		{"", 0}, {"0s", 0}, {"-1h", 0}, {"1.5h", 0}, {"1", 0}, {" 1h", 0},
		{"1h ", 0}, {"1M", 0}, {"1ms", 0}, {"2147483648s", 0},
		{"2147483647s1s", 0}, {"9999999999999999999999999999d", 0},
	} {
		t.Run(tc.input, func(t *testing.T) {
			got, ok := ParseExpirationDuration(tc.input)
			if got != tc.want || ok != (tc.want > 0) {
				t.Fatalf("got (%d, %v), want %d", got, ok, tc.want)
			}
		})
	}
}
