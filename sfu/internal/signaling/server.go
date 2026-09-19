package signaling

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/moadabdou/Kith/sfu/internal/auth"
	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/moadabdou/Kith/sfu/internal/room"
	"github.com/pion/webrtc/v4"
)

// Inbound/Outbound message payload structures
type Message struct {
	Type       string                   `json:"type"`
	Token      string                   `json:"token,omitempty"`
	ChannelID  string                   `json:"channel_id,omitempty"`
	GuildID    string                   `json:"guild_id,omitempty"`
	SDP        string                   `json:"sdp,omitempty"`
	Candidate  *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	Peers      []string                 `json:"peers,omitempty"`
	UserID     string                   `json:"user_id,omitempty"`
	Speaking   *bool                    `json:"speaking,omitempty"`
	ListenOnly *bool                    `json:"listen_only,omitempty"`
	Message    string                   `json:"message,omitempty"`
}

// Server provides the HTTP handler for WebSocket signaling.
type Server struct {
	roomMgr   *room.Manager
	webrtcAPI *webrtc.API
	jwtSecret string
	rtcConfig webrtc.Configuration
}

// NewServer initializes a new signaling server.
func NewServer(roomMgr *room.Manager, api *webrtc.API, jwtSecret string, rtcConfig webrtc.Configuration) *Server {
	return &Server{
		roomMgr:   roomMgr,
		webrtcAPI: api,
		jwtSecret: jwtSecret,
		rtcConfig: rtcConfig,
	}
}

// ServeHTTP handles incoming WebSocket upgrade requests.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		slog.Error("Failed to accept websocket connection", "err", err)
		return
	}
	defer conn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	s.handleSession(ctx, conn)
}

func (s *Server) handleSession(ctx context.Context, conn *websocket.Conn) {
	var (
		currentPeer *peer.Peer
		currentRoom *room.Room
		userID      string
		writeMu     sync.Mutex
	)

	writeJSON := func(msg Message) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
		defer writeCancel()
		return wsjson.Write(writeCtx, conn, msg)
	}

	defer func() {
		if currentRoom != nil && userID != "" {
			_ = currentRoom.Leave(userID)
		}
		if currentPeer != nil {
			_ = currentPeer.Close()
		}
	}()

	for {
		var msg Message
		if err := wsjson.Read(ctx, conn, &msg); err != nil {
			if errors.Is(err, context.Canceled) || websocket.CloseStatus(err) != -1 {
				slog.Debug("Signaling connection closed", "user_id", userID)
				return
			}
			slog.Warn("Failed to read signaling message", "err", err)
			return
		}

		metrics.SignalingMessages.WithLabelValues(msg.Type).Inc()

		switch msg.Type {
		case "join":
			if currentPeer != nil {
				_ = writeJSON(Message{Type: "error", Message: "already joined a room"})
				continue
			}

			claims, err := auth.ValidateVoiceToken(msg.Token, s.jwtSecret)
			if err != nil {
				slog.Warn("Voice token validation failed", "err", err)
				_ = writeJSON(Message{Type: "error", Message: "unauthorized: invalid token"})
				return
			}

			userID = claims.UserID
			channelID := msg.ChannelID
			if channelID == "" {
				channelID = claims.ChannelID
			}
			if channelID == "" {
				_ = writeJSON(Message{Type: "error", Message: "missing channel_id"})
				return
			}

			sessionID := fmt.Sprintf("sess_%d", time.Now().UnixNano())
			p, err := peer.NewPeer(s.webrtcAPI, s.rtcConfig, userID, sessionID, channelID)
			if err != nil {
				slog.Error("Failed to create peer", "user_id", userID, "err", err)
				_ = writeJSON(Message{Type: "error", Message: "internal server error"})
				return
			}
			currentPeer = p

			// Goroutine to stream local ICE candidates to client
			go func() {
				for cand := range p.Candidates {
					c := cand
					_ = writeJSON(Message{
						Type:      "candidate",
						Candidate: &c,
					})
				}
			}()

			r := s.roomMgr.GetOrCreate(channelID)
			currentRoom = r

			sender := func(_targetUID string, ev room.Event) {
				_ = writeJSON(Message{
					Type:      ev.Type,
					UserID:    ev.UserID,
					ChannelID: ev.ChannelID,
					Speaking:  ev.Speaking,
					Peers:     ev.Peers,
					SDP:       ev.SDP,
				})
			}

			if err := r.Join(p, sender); err != nil {
				slog.Error("Failed to join room", "room_id", channelID, "err", err)
				_ = writeJSON(Message{Type: "error", Message: "failed to join room"})
				return
			}

			peers, _ := r.GetPeers()
			_ = writeJSON(Message{
				Type:      "joined",
				ChannelID: channelID,
				Peers:     peers,
			})

			// If the user joined in listen-only mode, immediately subscribe to existing speakers
			if msg.ListenOnly != nil && *msg.ListenOnly && currentRoom != nil {
				currentRoom.Router().SubscribeToExistingPublishers(userID)
			}

		case "offer":
			if currentPeer == nil {
				_ = writeJSON(Message{Type: "error", Message: "must join before sending offer"})
				continue
			}

			answer, err := currentPeer.HandleOffer(msg.SDP)
			if err != nil {
				slog.Error("Failed to handle offer", "user_id", userID, "err", err)
				_ = writeJSON(Message{Type: "error", Message: "failed to process offer"})
				continue
			}

			_ = writeJSON(Message{
				Type: "answer",
				SDP:  answer.SDP,
			})

			// If other participants are already publishing, attach downlinks now that signaling is stable
			if currentRoom != nil {
				currentRoom.Router().SubscribeToExistingPublishers(userID)
			}

		case "answer":
			if currentPeer == nil {
				_ = writeJSON(Message{Type: "error", Message: "must join before sending answer"})
				continue
			}

			if err := currentPeer.HandleAnswer(msg.SDP); err != nil {
				slog.Error("Failed to handle answer", "user_id", userID, "err", err)
				_ = writeJSON(Message{Type: "error", Message: "failed to process answer"})
				continue
			}

			// Signaling state has returned to Stable; flush any postponed renegotiation
			if currentRoom != nil {
				currentRoom.Router().OnSignalingStateStable(userID)
			}

		case "candidate":
			if currentPeer == nil || msg.Candidate == nil {
				continue
			}

			if err := currentPeer.AddCandidate(*msg.Candidate); err != nil {
				slog.Debug("Failed to add remote candidate", "user_id", userID, "err", err)
			}

		case "speaking":
			if currentRoom != nil && userID != "" && msg.Speaking != nil {
				currentRoom.Broadcast(userID, room.Event{
					Type:      "speaking",
					UserID:    userID,
					ChannelID: currentRoom.ID,
					Speaking:  msg.Speaking,
				})
			}

		case "leave":
			return

		default:
			slog.Warn("Unknown signaling message type", "type", msg.Type)
		}
	}
}
