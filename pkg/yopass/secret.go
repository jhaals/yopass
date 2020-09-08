package yopass

import "encoding/json"

// Secret holds the encrypted message
type Secret struct {
	Expiration int32  `json:"expiration,omitempty"`
	Message    string `json:"message"`
	OneTime    bool   `json:"one_time,omitempty"`
}

// ToJSON converts a Secret to json
func (s *Secret) ToJSON() ([]byte, error) {
	return json.Marshal(&s)
}
