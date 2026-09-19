package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	ActiveRooms = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_active_rooms",
		Help: "Current number of active voice rooms managed by the SFU.",
	})

	ConnectedPeers = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_connected_peers",
		Help: "Current number of connected peers in the SFU.",
	})

	SignalingMessages = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sfu_signaling_messages_total",
		Help: "Total number of signaling messages processed by message type.",
	}, []string{"type"})

	ICEStates = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sfu_ice_connection_states_total",
		Help: "Total count of ICE connection state transitions.",
	}, []string{"state"})
)
