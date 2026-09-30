package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type GatewayMsg struct {
	Op int            `json:"op"`
	T  string         `json:"t,omitempty"`
	S  *int64         `json:"s,omitempty"`
	D  map[string]any `json:"d,omitempty"`
}

func connectAndIdentify(ctx context.Context, wsURL, token string) (*websocket.Conn, error) {
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}

	// 1. Read Op 10 Hello
	var hello GatewayMsg
	if err := wsjson.Read(ctx, c, &hello); err != nil {
		c.Close(websocket.StatusInternalError, "read hello failed")
		return nil, fmt.Errorf("read hello: %w", err)
	}
	if hello.Op != 10 {
		c.Close(websocket.StatusInternalError, "unexpected op")
		return nil, fmt.Errorf("expected op 10 hello, got %d", hello.Op)
	}

	// 2. Send Op 2 Identify
	identify := map[string]any{
		"op": 2,
		"d": map[string]any{
			"token": token,
			"properties": map[string]any{
				"$os":      "linux",
				"$browser": "go-test",
				"$device":  "go-test",
			},
		},
	}
	if err := wsjson.Write(ctx, c, identify); err != nil {
		c.Close(websocket.StatusInternalError, "write identify failed")
		return nil, fmt.Errorf("write identify: %w", err)
	}

	// 3. Read until READY
	for {
		var msg GatewayMsg
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			c.Close(websocket.StatusInternalError, "read ready failed")
			return nil, fmt.Errorf("read ready: %w", err)
		}
		if msg.Op == 0 && msg.T == "READY" {
			break
		}
	}

	return c, nil
}

func main() {
	apiBase := flag.String("api", "http://localhost:80/api", "API Base URL")
	tokenA := flag.String("token-a", "", "User A Token")
	tokenB := flag.String("token-b", "", "User B Token")
	channelID := flag.String("channel", "", "Channel ID")
	userAID := flag.String("user-a", "", "User A ID")
	userBID := flag.String("user-b", "", "User B ID")
	msgID := flag.String("msg-id", "", "Message ID to ack")
	gwURL := flag.String("gw", "ws://127.0.0.1:4000/ws", "Gateway WS URL")
	flag.Parse()

	if *tokenA == "" || *tokenB == "" || *channelID == "" || *msgID == "" {
		log.Fatalf("missing required flags")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	fmt.Printf("Connecting User A and User B to Gateway at %s...\n", *gwURL)
	connA, err := connectAndIdentify(ctx, *gwURL, *tokenA)
	if err != nil {
		log.Fatalf("User A connect failed: %v", err)
	}
	defer connA.Close(websocket.StatusNormalClosure, "done")
	fmt.Printf("  User A (id: %s) connected and identified successfully.\n", *userAID)

	connB, err := connectAndIdentify(ctx, *gwURL, *tokenB)
	if err != nil {
		log.Fatalf("User B connect failed: %v", err)
	}
	defer connB.Close(websocket.StatusNormalClosure, "done")
	fmt.Printf("  User B (id: %s) connected and identified successfully.\n", *userBID)

	// Listeners
	var userAAckReceived bool
	var userBAckReceived bool
	var mu sync.Mutex

	// Goroutine for User A
	go func() {
		for {
			var msg GatewayMsg
			if err := wsjson.Read(ctx, connA, &msg); err != nil {
				return
			}
			if msg.T == "MESSAGE_ACK" {
				mu.Lock()
				userAAckReceived = true
				mu.Unlock()
				fmt.Printf("  [User A WS] Received self-targeted MESSAGE_ACK: %+v\n", msg.D)
			}
		}
	}()

	// Goroutine for User B
	go func() {
		for {
			var msg GatewayMsg
			if err := wsjson.Read(ctx, connB, &msg); err != nil {
				return
			}
			if msg.T == "MESSAGE_ACK" {
				mu.Lock()
				userBAckReceived = true
				mu.Unlock()
				fmt.Printf("  [LEAK!] User B WS erroneously received MESSAGE_ACK: %+v\n", msg.D)
			}
		}
	}()

	// Small pause to ensure subscriptions converge
	time.Sleep(300 * time.Millisecond)

	// Send ACK via HTTP API for User A
	fmt.Printf("Sending POST /channels/%s/messages/%s/ack for User A...\n", *channelID, *msgID)
	ackURL := fmt.Sprintf("%s/channels/%s/messages/%s/ack", *apiBase, *channelID, *msgID)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, ackURL, strings.NewReader(`{"manual":false,"mention_count":0}`))
	req.Header.Set("Authorization", "Bearer "+*tokenA)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Fatalf("HTTP ack failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		log.Fatalf("expected 204 No Content, got %d", resp.StatusCode)
	}

	// Wait up to 3 seconds for WebSocket events
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		gotA := userAAckReceived
		mu.Unlock()
		if gotA {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Final verification
	mu.Lock()
	defer mu.Unlock()

	if !userAAckReceived {
		log.Fatalf("FAIL: User A did NOT receive self-targeted MESSAGE_ACK event via WebSocket!")
	}
	if userBAckReceived {
		log.Fatalf("FAIL: User B received MESSAGE_ACK event! Leakage to guild peer detected!")
	}

	fmt.Printf("SUCCESS: User A received MESSAGE_ACK; User B received ZERO MESSAGE_ACK events.\n")
}
