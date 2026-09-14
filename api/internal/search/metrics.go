package search

import (
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	metricsOnce sync.Once

	// ProcessedEventsTotal counts processed events partitioned by event type (create, update, delete).
	ProcessedEventsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "search_indexer_processed_events_total",
			Help: "Total events processed by the search indexer",
		},
		[]string{"type"},
	)

	// BatchSize measures the number of documents/mutations flushed in each micro-batch.
	BatchSize = prometheus.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "search_indexer_batch_size",
			Help:    "Number of items flushed to Meilisearch per batch",
			Buckets: []float64{1, 5, 10, 25, 50, 75, 100, 150},
		},
	)

	// FlushDuration measures the duration in seconds of Meilisearch batch flush calls.
	FlushDuration = prometheus.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "search_indexer_flush_duration_seconds",
			Help:    "Duration of Meilisearch batch flush operations in seconds",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0},
		},
	)
)

// RegisterMetrics registers the indexer Prometheus metrics idempotently.
func RegisterMetrics() {
	metricsOnce.Do(func() {
		prometheus.MustRegister(ProcessedEventsTotal)
		prometheus.MustRegister(BatchSize)
		prometheus.MustRegister(FlushDuration)
	})
}
