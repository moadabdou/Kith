package peer

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/logging"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// pionLoggerFactory routes Pion internals (pc, ice, dtls, rtp, rtcp, srtp…)
// through slog at SFU_PION_LOG (default warn) so OnTrack/peek/codec failures
// are diagnosable without drowning the log.
type pionLoggerFactory struct {
	level logging.LogLevel
}

type pionLogger struct {
	scope string
	level logging.LogLevel
}

func newPionLoggerFactory() logging.LoggerFactory {
	lvl := logging.LogLevelWarn
	switch strings.ToLower(strings.TrimSpace(os.Getenv("SFU_PION_LOG"))) {
	case "trace":
		lvl = logging.LogLevelTrace
	case "debug":
		lvl = logging.LogLevelDebug
	case "info":
		lvl = logging.LogLevelInfo
	case "error":
		lvl = logging.LogLevelError
	case "disabled", "none", "off":
		lvl = logging.LogLevelDisabled
	}
	return &pionLoggerFactory{level: lvl}
}

func (f *pionLoggerFactory) NewLogger(scope string) logging.LeveledLogger {
	return &pionLogger{scope: "pion/" + scope, level: f.level}
}

func (l *pionLogger) levelEnabled(want logging.LogLevel) bool {
	// Disabled=0 … Trace=6: higher value = more verbose.
	return l.level != logging.LogLevelDisabled && want <= l.level
}

func (l *pionLogger) log(level slog.Level, msg string) {
	slog.Log(nil, level, msg, "scope", l.scope)
}

func (l *pionLogger) Trace(msg string)                 { if l.levelEnabled(logging.LogLevelTrace) { l.log(slog.LevelDebug, msg) } }
func (l *pionLogger) Tracef(f string, a ...any)        { if l.levelEnabled(logging.LogLevelTrace) { l.log(slog.LevelDebug, fmt.Sprintf(f, a...)) } }
func (l *pionLogger) Debug(msg string)                 { if l.levelEnabled(logging.LogLevelDebug) { l.log(slog.LevelDebug, msg) } }
func (l *pionLogger) Debugf(f string, a ...any)        { if l.levelEnabled(logging.LogLevelDebug) { l.log(slog.LevelDebug, fmt.Sprintf(f, a...)) } }
func (l *pionLogger) Info(msg string)                  { if l.levelEnabled(logging.LogLevelInfo) { l.log(slog.LevelInfo, msg) } }
func (l *pionLogger) Infof(f string, a ...any)         { if l.levelEnabled(logging.LogLevelInfo) { l.log(slog.LevelInfo, fmt.Sprintf(f, a...)) } }
func (l *pionLogger) Warn(msg string)                  { if l.levelEnabled(logging.LogLevelWarn) { l.log(slog.LevelWarn, msg) } }
func (l *pionLogger) Warnf(f string, a ...any)         { if l.levelEnabled(logging.LogLevelWarn) { l.log(slog.LevelWarn, fmt.Sprintf(f, a...)) } }
func (l *pionLogger) Error(msg string)                 { if l.levelEnabled(logging.LogLevelError) { l.log(slog.LevelError, msg) } }
func (l *pionLogger) Errorf(f string, a ...any)        { if l.levelEnabled(logging.LogLevelError) { l.log(slog.LevelError, fmt.Sprintf(f, a...)) } }
func (l *pionLogger) Fatal(msg string)                 { l.log(slog.LevelError, msg) }
func (l *pionLogger) Fatalf(f string, a ...any)        { l.log(slog.LevelError, fmt.Sprintf(f, a...)) }

// Config configures Pion WebRTC settings for the SFU.
type Config struct {
	UDPPortMin uint16
	UDPPortMax uint16
	NAT1To1IPs []string
	ICEServers []webrtc.ICEServer
}

// Peer represents a connected participant in a voice room.
type Peer struct {
	UserID            string
	SessionID         string
	ChannelID         string
	GuildID           string
	PC                *webrtc.PeerConnection
	Candidates        chan webrtc.ICECandidateInit
	onTrack           func(*webrtc.TrackRemote, *webrtc.RTPReceiver)
	onClose           func()
	onSignalingStable func()

	mu     sync.Mutex
	closed bool
}

// NewPeer constructs and initializes a new WebRTC PeerConnection for a user.
func NewPeer(api *webrtc.API, config webrtc.Configuration, userID, sessionID, channelID, guildID string) (*Peer, error) {
	pc, err := api.NewPeerConnection(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create peer connection: %w", err)
	}

	p := &Peer{
		UserID:     userID,
		SessionID:  sessionID,
		ChannelID:  channelID,
		GuildID:    guildID,
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
		if state == webrtc.ICEConnectionStateFailed {
			slog.Warn("ICE Connection failed, closing peer", "user_id", userID)
			p.Close()
		}
	})

	pc.OnSignalingStateChange(func(state webrtc.SignalingState) {
		slog.Debug("Signaling state changed", "user_id", userID, "state", state.String())
		p.mu.Lock()
		cb := p.onSignalingStable
		p.mu.Unlock()
		if state == webrtc.SignalingStateStable && cb != nil {
			cb()
		}
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

// SetOnClose sets the callback invoked when the Peer is closed or fails.
func (p *Peer) SetOnClose(cb func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onClose = cb
}

// SetOnSignalingStable sets the callback invoked when the connection transitions to SignalingStateStable.
func (p *Peer) SetOnSignalingStable(cb func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onSignalingStable = cb
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

// WriteRTCP sends user-provided RTCP packets to the remote peer.
func (p *Peer) WriteRTCP(pkts []rtcp.Packet) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || p.PC == nil {
		return fmt.Errorf("peer is closed")
	}
	return p.PC.WriteRTCP(pkts)
}

// Close gracefully closes the PeerConnection.
func (p *Peer) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	close(p.Candidates)
	onClose := p.onClose
	p.mu.Unlock()

	if onClose != nil {
		onClose()
	}
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

	// Register RTCP feedback mechanisms for video codecs (VP8, H.264)
	videoFeedbacks := []webrtc.RTCPFeedback{
		{Type: "nack"},
		{Type: "nack", Parameter: "pli"},
		{Type: "goog-remb"},
		{Type: "ccm", Parameter: "fir"},
	}
	for _, fb := range videoFeedbacks {
		mediaEngine.RegisterFeedback(fb, webrtc.RTPCodecTypeVideo)
	}

	settingEngine.LoggerFactory = newPionLoggerFactory()

	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
	), nil
}
