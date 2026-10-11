package yopass

import "math"

// ParseExpirationDuration parses positive whole-second durations using s, m,
// h, d (24 hours), and w (7 days), including combinations such as 1d12h.
// Fractional amounts, signs, whitespace, and values exceeding int32 are rejected.
func ParseExpirationDuration(s string) (int32, bool) {
	var total int64
	if s == "" {
		return 0, false
	}
	for len(s) > 0 {
		i := 0
		var amount int64
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			digit := int64(s[i] - '0')
			if amount > (math.MaxInt32-digit)/10 {
				return 0, false
			}
			amount = amount*10 + digit
			i++
		}
		if i == 0 || i == len(s) {
			return 0, false
		}
		var unit int64
		switch s[i] {
		case 's':
			unit = 1
		case 'm':
			unit = 60
		case 'h':
			unit = 3600
		case 'd':
			unit = 86400
		case 'w':
			unit = 604800
		default:
			return 0, false
		}
		if amount > (math.MaxInt32-total)/unit {
			return 0, false
		}
		total += amount * unit
		s = s[i+1:]
	}
	return int32(total), total > 0
}
