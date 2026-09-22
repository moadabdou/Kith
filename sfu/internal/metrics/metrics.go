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

	RTCPNackForwarded = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtcp_nack_forwarded_total",
		Help: "Total number of RTCP NACK requests translated and forwarded to publishers.",
	})

	RTXRepaired = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtx_repaired_total",
		Help: "Retransmitted packets surfaced by Pion ingress repair (RTX stream consumed).",
	})

	RTXForwarded = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtx_forwarded_total",
		Help: "Repaired packets written to subscriber downlinks with gap seqs.",
	})

	RTXUnmatched = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtx_unmatched_total",
		Help: "Repaired packets dropped per subscriber: no reverse seq mapping (aged out or never forwarded).",
	})

	RTCPPLITotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtcp_pli_total",
		Help: "Total number of RTCP PLI (Picture Loss Indication) requests received from subscribers.",
	})

	PLIRequestsReceived = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_pli_requests_received_total",
		Help: "Total number of PLI/FIR keyframe requests received from subscribers (issue #81).",
	})

	PLIRequestsForwarded = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_pli_requests_forwarded_total",
		Help: "Total number of PLI/FIR keyframe requests forwarded to publishers after coalescing (issue #81).",
	})

	LayerDistribution = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "sfu_layer_distribution",
		Help: "Current number of video downlinks per simulcast layer (issue #82).",
	}, []string{"layer"})

	LayerSwitches = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "sfu_layer_switches_total",
		Help: "Total simulcast layer switches by direction (issue #82).",
	}, []string{"direction"})

	RTCPFIRTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "sfu_rtcp_fir_total",
		Help: "Total number of RTCP FIR (Full Intra Request) requests received from subscribers.",
	})

	FractionLost = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "sfu_fraction_lost",
		Help: "Latest average fraction of packet loss reported by subscribers via RTCP Receiver Reports.",
	})
)
