package router

import (
	"context"
	"io"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
)

// PublisherUplink manages an ingress audio track from a publisher and distributes RTP packets
// to all subscribed downlinks.
type PublisherUplink struct {
	PublisherID string
	TrackRemote *webrtc.TrackRemote
	Receiver    *webrtc.RTPReceiver

	mu          sync.RWMutex
	subscribers map[string]*SubscriberDownlink

	ctx       context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
}

// NewPublisherUplink creates and starts a new publisher uplink reader.
func NewPublisherUplink(pubID string, trackRemote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) *PublisherUplink {
	ctx, cancel := context.WithCancel(context.Background())
	p := &PublisherUplink{
		PublisherID: pubID,
		TrackRemote: trackRemote,
		Receiver:    receiver,
		subscribers: make(map[string]*SubscriberDownlink),
		ctx:         ctx,
		cancel:      cancel,
	}

	if trackRemote != nil {
		go p.readingLoop()
	}
	return p
}

// AddSubscriber adds or updates a subscriber downlink for this publisher.
func (p *PublisherUplink) AddSubscriber(sub *SubscriberDownlink) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if existing, ok := p.subscribers[sub.SubscriberID]; ok {
		existing.Close()
	}
	p.subscribers[sub.SubscriberID] = sub
}

// RemoveSubscriber removes and closes a subscriber downlink by ID.
func (p *PublisherUplink) RemoveSubscriber(subID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if sub, ok := p.subscribers[subID]; ok {
		sub.Close()
		delete(p.subscribers, subID)
	}
}

// readingLoop reads RTP packets from the remote track and fans them out to all subscribers.
func (p *PublisherUplink) readingLoop() {
	defer func() {
		slog.Debug("Publisher reading loop terminated", "publisher_id", p.PublisherID)
	}()

	for {
		select {
		case <-p.ctx.Done():
			return
		default:
			pkt, _, err := p.TrackRemote.ReadRTP()
			if err != nil {
				if err != io.EOF {
					slog.Warn("Failed to read RTP from publisher", "publisher_id", p.PublisherID, "err", err)
				} else {
					slog.Info("Publisher track reached EOF", "publisher_id", p.PublisherID)
				}
				p.Close()
				return
			}

			p.mu.RLock()
			for _, sub := range p.subscribers {
				// Deep-copy packet to allow independent sequence number rewriting per subscriber
				sub.Enqueue(pkt.Clone())
			}
			p.mu.RUnlock()
		}
	}
}

// Close gracefully closes the publisher reading loop and all attached subscribers.
func (p *PublisherUplink) Close() {
	p.closeOnce.Do(func() {
		p.cancel()
		p.mu.Lock()
		defer p.mu.Unlock()
		for id, sub := range p.subscribers {
			sub.Close()
			delete(p.subscribers, id)
		}
	})
}
