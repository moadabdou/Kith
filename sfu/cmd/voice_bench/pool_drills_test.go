package main

// Unit tests for the pool-drill endpoint mapping (Phase 7d Step 6b).
// The drill driver runs on host network: compose service names must map to
// host-dialable URLs, everything else passes through untouched.

import "testing"

func TestSfuWSForEndpoint(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"sfu:5000", "ws://127.0.0.1:5000/ws"},
		{"sfu-2:5001", "ws://127.0.0.1:5001/ws"},
		{"sfu.kith.local:7000", "ws://127.0.0.1:7000/ws"},
		{"localhost:5000", "ws://127.0.0.1:5000/ws"},
		{"127.0.0.1:5000", "ws://127.0.0.1:5000/ws"},
		{"0.0.0.0:5000", "ws://127.0.0.1:5000/ws"},
		{"voice.prod.example:443", "ws://voice.prod.example:443/ws"},
		{"ws://custom:5000", "ws://custom:5000/ws"},
		{"ws://custom:5000/ws", "ws://custom:5000/ws"},
		{"wss://secure:5000/ws", "wss://secure:5000/ws"},
	}
	for _, tc := range cases {
		if got := sfuWSForEndpoint(tc.in); got != tc.want {
			t.Errorf("sfuWSForEndpoint(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
