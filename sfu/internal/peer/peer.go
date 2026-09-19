package peer

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/webrtc/v4"
)

// Config configures Pion WebRTC settings for the SFU.
type Config struct {
	UDPPortMin uint16
	UDPPortMax uint16
	NAT1To1IPs []string
	ICEServers []webrtc.ICEServer
}

// Peer represents a connected participant in a voice room.
type Peer struct {
	UserID     string
	SessionID  string
	ChannelID  string
	PC         *webrtc.PeerConnection
	Candidates chan webrtc.ICECandidateInit
	onTrack    func(*webrtc.TrackRemote, *webrtc.RTPReceiver)

	mu     sync.Mutex
	closed bool
}

// NewPeer constructs and initializes a new WebRTC PeerConnection for a user.
func NewPeer(api *webrtc.API, config webrtc.Configuration, userID, sessionID, channelID string) (*Peer, error) {
	pc, err := api.NewPeerConnection(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create peer connection: %w", err)
	}

	p := &Peer{
		UserID:     userID,
		SessionID:  sessionID,
		ChannelID:  channelID,
		PC:         pc,
		Candidates: make(chan webrtc.ICECandidateInit, 64),
	}

	// Capture local ICE candidates to trickle to client
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candidateJSON := c.ToJSON()
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.closed {
			return
		}

		select {
		case p.Candidates <- candidateJSON:
		default:
			slog.Warn("ICE candidate channel full, dropping", "user_id", userID)
		}
	})

	// Track connection state
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		slog.Debug("ICE Connection State changed", "user_id", userID, "state", state.String())
		metrics.ICEStates.WithLabelValues(state.String()).Inc()
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		slog.Info("PeerConnection state changed", "user_id", userID, "state", state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			p.Close()
		}
	})

	// Handle remote audio track arrival (for Phase 5c relay in Issue #73)
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		p.mu.Lock()
		cb := p.onTrack
		p.mu.Unlock()

		if cb != nil {
			cb(track, receiver)
		} else {
			slog.Debug("Remote track received from peer", "user_id", userID, "kind", track.Kind().String(), "id", track.ID())
		}
	})

	return p, nil
}

// SetOnTrack sets the callback invoked when a remote RTP track arrives.
func (p *Peer) SetOnTrack(cb func(*webrtc.TrackRemote, *webrtc.RTPReceiver)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onTrack = cb
}

// HandleOffer processes an incoming SDP offer and creates an SDP answer.
func (p *Peer) HandleOffer(sdp string) (*webrtc.SessionDescription, error) {
	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  sdp,
	}

	if err := p.PC.SetRemoteDescription(offer); err != nil {
		return nil, fmt.Errorf("failed to set remote description: %w", err)
	}

	answer, err := p.PC.CreateAnswer(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create answer: %w", err)
	}

	if err := p.PC.SetLocalDescription(answer); err != nil {
		return nil, fmt.Errorf("failed to set local description: %w", err)
	}

	return &answer, nil
}

// AddCandidate registers an ICE candidate from the remote client.
func (p *Peer) AddCandidate(candidate webrtc.ICECandidateInit) error {
	return p.PC.AddICECandidate(candidate)
}

// AddTrack adds a local track (downlink) to this peer's PeerConnection.
func (p *Peer) AddTrack(track webrtc.TrackLocal) (*webrtc.RTPSender, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, fmt.Errorf("peer is closed")
	}
	return p.PC.AddTrack(track)
}

// RemoveTrack removes a sender (downlink track) from this peer's PeerConnection.
func (p *Peer) RemoveTrack(sender *webrtc.RTPSender) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	return p.PC.RemoveTrack(sender)
}

// CreateOffer generates an SDP offer for server-initiated renegotiation (e.g. adding downlinks).
func (p *Peer) CreateOffer() (*webrtc.SessionDescription, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, fmt.Errorf("peer is closed")
	}

	offer, err := p.PC.CreateOffer(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create offer: %w", err)
	}

	if err := p.PC.SetLocalDescription(offer); err != nil {
		return nil, fmt.Errorf("failed to set local description: %w", err)
	}

	return &offer, nil
}

// HandleAnswer processes an incoming SDP answer from the client in response to a server offer.
func (p *Peer) HandleAnswer(sdp string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return fmt.Errorf("peer is closed")
	}

	answer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	}

	return p.PC.SetRemoteDescription(answer)
}

// Close gracefully closes the PeerConnection.
func (p *Peer) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return nil
	}
	p.closed = true
	close(p.Candidates)
	return p.PC.Close()
}

// CreateAPI initializes a shared Pion WebRTC API instance with ephemeral port limits.
func CreateAPI(cfg Config) (*webrtc.API, error) {
	settingEngine := webrtc.SettingEngine{}

	if cfg.UDPPortMin > 0 && cfg.UDPPortMax >= cfg.UDPPortMin {
		if err := settingEngine.SetEphemeralUDPPortRange(cfg.UDPPortMin, cfg.UDPPortMax); err != nil {
			return nil, fmt.Errorf("invalid UDP port range %d-%d: %w", cfg.UDPPortMin, cfg.UDPPortMax, err)
		}
	}

	if len(cfg.NAT1To1IPs) > 0 {
		settingEngine.SetNAT1To1IPs(cfg.NAT1To1IPs, webrtc.ICECandidateTypeHost)
	}

	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("failed to register codecs: %w", err)
	}

	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
	), nil
}
