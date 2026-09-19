package signaling

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/golang-jwt/jwt/v5"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/moadabdou/Kith/sfu/internal/room"
	"github.com/pion/webrtc/v4"
)

const testSecret = "sfu-test-jwt-secret-key-12345678"

func generateToken(t *testing.T, userID, channelID string) string {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":        userID,
		"channel_id": channelID,
		"exp":        time.Now().Add(time.Hour).Unix(),
	})
	signed, err := token.SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("failed to sign token: %v", err)
	}
	return signed
}

func setupTestServer(t *testing.T) (*httptest.Server, *room.Manager) {
	roomMgr := room.NewManager()
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create WebRTC API: %v", err)
	}

	server := NewServer(roomMgr, api, testSecret, webrtc.Configuration{})
	ts := httptest.NewServer(server)
	return ts, roomMgr
}

func TestSignalingJoinAndOffer(t *testing.T) {
	ts, roomMgr := setupTestServer(t)
	defer ts.Close()
	defer roomMgr.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	defer conn.CloseNow()

	// 1. Send Join
	token := generateToken(t, "user_alice", "chan_voice_1")
	err = wsjson.Write(ctx, conn, Message{
		Type:      "join",
		Token:     token,
		ChannelID: "chan_voice_1",
	})
	if err != nil {
		t.Fatalf("failed to send join: %v", err)
	}

	// 2. Expect Joined
	var resp Message
	err = wsjson.Read(ctx, conn, &resp)
	if err != nil {
		t.Fatalf("failed to read joined response: %v", err)
	}
	if resp.Type != "joined" || resp.ChannelID != "chan_voice_1" {
		t.Fatalf("unexpected join response: %+v", resp)
	}

	// 3. Create client peer connection to generate a real SDP offer
	clientPC, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("failed to create client peer connection: %v", err)
	}
	defer clientPC.Close()

	// Add audio transceiver
	_, err = clientPC.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio)
	if err != nil {
		t.Fatalf("failed to add transceiver: %v", err)
	}

	offer, err := clientPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("failed to create offer: %v", err)
	}
	if err := clientPC.SetLocalDescription(offer); err != nil {
		t.Fatalf("failed to set local description: %v", err)
	}

	// 4. Send offer to SFU
	err = wsjson.Write(ctx, conn, Message{
		Type: "offer",
		SDP:  offer.SDP,
	})
	if err != nil {
		t.Fatalf("failed to send offer: %v", err)
	}

	// 5. Expect answer
	var answerResp Message
	for {
		err = wsjson.Read(ctx, conn, &answerResp)
		if err != nil {
			t.Fatalf("failed to read answer response: %v", err)
		}
		if answerResp.Type == "answer" {
			break
		}
		// Candidate messages may trickle before answer
		if answerResp.Type == "candidate" {
			continue
		}
		t.Fatalf("unexpected response instead of answer: %+v", answerResp)
	}

	if answerResp.SDP == "" {
		t.Fatal("expected non-empty SDP in answer")
	}

	// Set remote description on client
	err = clientPC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  answerResp.SDP,
	})
	if err != nil {
		t.Fatalf("client failed to set remote description: %v", err)
	}
}

func TestSignalingUnauthorized(t *testing.T) {
	ts, roomMgr := setupTestServer(t)
	defer ts.Close()
	defer roomMgr.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	defer conn.CloseNow()

	// Send join with invalid token
	err = wsjson.Write(ctx, conn, Message{
		Type:      "join",
		Token:     "invalid-token-string",
		ChannelID: "chan_voice_1",
	})
	if err != nil {
		t.Fatalf("failed to write message: %v", err)
	}

	var resp Message
	err = wsjson.Read(ctx, conn, &resp)
	if err != nil {
		t.Fatalf("failed to read response: %v", err)
	}

	if resp.Type != "error" {
		t.Fatalf("expected error message, got: %+v", resp)
	}
}
