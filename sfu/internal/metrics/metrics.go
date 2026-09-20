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

	PacketsForwarded = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_packets_forwarded_total",
		Help: "Total number of RTP audio packets successfully forwarded.",
	})

	PacketsDropped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_packets_dropped_total",
		Help: "Total number of RTP packets dropped due to subscriber queue saturation.",
	})

	SubQueueDepth = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_sub_queue_depth",
		Help: "Aggregated depth of active subscriber packet queues.",
	})

	RTCPNackTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtcp_nack_total",
		Help: "Total number of RTCP NACK requests received from subscribers.",
	})

	RTCPPLITotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtcp_pli_total",
		Help: "Total number of RTCP PLI (Picture Loss Indication) requests received from subscribers.",
	})

	RTCPFIRTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtcp_fir_total",
		Help: "Total number of RTCP FIR (Full Intra Request) requests received from subscribers.",
	})

	FractionLost = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_fraction_lost",
		Help: "Latest average fraction of packet loss reported by subscribers via RTCP Receiver Reports.",
	})
)
